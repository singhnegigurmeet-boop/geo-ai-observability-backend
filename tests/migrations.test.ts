import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../src/db/migration-runner.js";

const runDatabaseTests = process.env.RUN_MIGRATION_TESTS === "true";
const expectedTables = [
  "analysis_run_items",
  "analysis_runs",
  "anonymous_sessions",
  "brands",
  "budget_policies",
  "categories",
  "domains",
  "entity_paths",
  "failure_records",
  "llm_runs",
  "notifications",
  "outbox_events",
  "products",
  "prompt_jobs",
  "provider_jobs",
  "provider_results",
  "provider_scores",
  "reports",
  "scheduler_jobs",
  "token_usage",
  "use_contexts",
  "user_sessions",
  "users",
  "workspace_members",
  "workspace_role_change_requests",
  "workspaces"
].sort();

const oldV5Tables = [
  "analysis_diffs",
  "discovery_requests",
  "domain_schedules",
  "provider_analysis",
  "provider_snapshots",
  "visibility_scores"
];

describe("incremental GEO V6 migrations", { skip: !runDatabaseTests }, () => {
  let pool: pg.Pool;
  let temporaryMigrationsDirectory: string;
  let migrationFilenames: string[];
  const retainedDomain = "survives.example";

  before(async () => {
    const connectionString =
      process.env.TEST_DATABASE_URL ??
      "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test";
    pool = new pg.Pool({ connectionString, max: 4 });

    const databaseResult = await pool.query<{ current_database: string }>(
      "SELECT current_database()"
    );
    const databaseName = databaseResult.rows[0]?.current_database;
    if (!databaseName?.endsWith("_test")) {
      throw new Error(
        `Refusing to reset migration test database without _test suffix: ${databaseName ?? "unknown"}`
      );
    }

    await pool.query("DROP SCHEMA IF EXISTS geo_meta CASCADE");
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");

    temporaryMigrationsDirectory = await mkdtemp(
      path.join(os.tmpdir(), "geo-v6-migrations-")
    );
    const sourceDirectory = getDefaultMigrationsDirectory();
    migrationFilenames = (await readdir(sourceDirectory))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();

    for (const filename of migrationFilenames.slice(0, 4)) {
      await cp(
        path.join(sourceDirectory, filename),
        path.join(temporaryMigrationsDirectory, filename)
      );
    }
  });

  after(async () => {
    await pool.end();
    await rm(temporaryMigrationsDirectory, { recursive: true, force: true });
  });

  it("applies early migrations and preserves rows through later migrations", async () => {
    const firstRun = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });
    assert.equal(firstRun.applied.length, 4);
    assert.equal(firstRun.skipped.length, 0);

    await pool.query(
      `
        INSERT INTO domains (normalized_domain, display_domain)
        VALUES ($1, $1)
      `,
      [retainedDomain]
    );

    const sourceDirectory = getDefaultMigrationsDirectory();
    for (const filename of migrationFilenames.slice(4)) {
      await cp(
        path.join(sourceDirectory, filename),
        path.join(temporaryMigrationsDirectory, filename)
      );
    }

    const laterRun = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });
    assert.equal(laterRun.applied.length, migrationFilenames.length - 4);
    assert.equal(laterRun.skipped.length, 4);

    const retained = await pool.query<{ normalized_domain: string }>(
      "SELECT normalized_domain FROM domains WHERE normalized_domain = $1",
      [retainedDomain]
    );
    assert.equal(retained.rows[0]?.normalized_domain, retainedDomain);
  });

  it("is a no-op on the second complete run", async () => {
    const result = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });

    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, migrationFilenames.length);
  });

  it("creates exactly the 26 frozen production tables and no V5 tables", async () => {
    const result = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const actualTables = result.rows.map((row) => row.table_name);

    assert.deepEqual(actualTables, expectedTables);
    for (const oldTable of oldV5Tables) {
      assert.equal(actualTables.includes(oldTable), false);
    }

    const ledger = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'geo_meta'
        AND table_name = 'schema_migrations'
    `);
    assert.equal(ledger.rowCount, 1);
  });

  it("enforces normalized-domain and entity-path hierarchy uniqueness", async () => {
    await assert.rejects(
      pool.query(
        "INSERT INTO domains (normalized_domain) VALUES ($1)",
        [retainedDomain]
      ),
      hasPostgresCode("23505")
    );

    const hierarchy = await createHierarchyFixture(pool);

    await assert.rejects(
      pool.query(
        `
          INSERT INTO entity_paths (
            domain_id,
            category_id,
            path_type
          )
          VALUES ($1, NULL, 'category')
        `,
        [hierarchy.domainId]
      ),
      hasPostgresCode("23514")
    );

    await assert.rejects(
      pool.query(
        `
          INSERT INTO entity_paths (
            domain_id,
            category_id,
            path_type
          )
          VALUES ($1, $2, 'category')
        `,
        [hierarchy.domainId, hierarchy.categoryId]
      ),
      hasPostgresCode("23505")
    );
  });

  it("enforces anonymous, logged-in, and claimed-run ownership", async () => {
    const ownership = await createOwnershipFixture(pool);
    const hierarchy = await getDomainEntityPath(pool);

    const anonymousRun = await insertAnalysisRun(pool, {
      idempotencyKey: "run-anonymous",
      anonymousSessionId: ownership.anonymousSessionId,
      userId: null,
      workspaceId: null,
      entityPathId: hierarchy.entityPathId
    });
    assert.ok(anonymousRun);

    await assert.rejects(
      insertAnalysisRun(pool, {
        idempotencyKey: "run-invalid-owner",
        anonymousSessionId: null,
        userId: ownership.memberUserId,
        workspaceId: null,
        entityPathId: hierarchy.entityPathId
      }),
      hasPostgresCode("23514")
    );

    await assert.rejects(
      insertAnalysisRun(pool, {
        idempotencyKey: "run-nonmember",
        anonymousSessionId: null,
        userId: ownership.nonmemberUserId,
        workspaceId: ownership.workspaceId,
        entityPathId: hierarchy.entityPathId
      }),
      hasPostgresCode("23503")
    );

    const claimedRun = await insertAnalysisRun(pool, {
      idempotencyKey: "run-claimed",
      anonymousSessionId: ownership.anonymousSessionId,
      userId: ownership.memberUserId,
      workspaceId: ownership.workspaceId,
      entityPathId: hierarchy.entityPathId
    });

    await assert.rejects(
      pool.query(
        `
          UPDATE analysis_runs
          SET anonymous_session_id = NULL
          WHERE analysis_run_id = $1
        `,
        [claimedRun]
      ),
      hasPostgresCode("23514")
    );
  });

  it("enforces workflow idempotency and immutable provider evidence", async () => {
    const ownership = await getOwnershipFixture(pool);
    const hierarchy = await getDomainEntityPath(pool);
    const runId = await insertAnalysisRun(pool, {
      idempotencyKey: "run-workflow",
      anonymousSessionId: null,
      userId: ownership.memberUserId,
      workspaceId: ownership.workspaceId,
      entityPathId: hierarchy.entityPathId
    });

    const itemId = await insertReturningId(
      pool,
      `
        INSERT INTO analysis_run_items (
          idempotency_key,
          analysis_run_id,
          entity_path_id,
          item_ordinal
        )
        VALUES ('item-workflow', $1, $2, 0)
        RETURNING analysis_run_item_id
      `,
      [runId, hierarchy.entityPathId],
      "analysis_run_item_id"
    );

    await assert.rejects(
      pool.query(
        `
          INSERT INTO analysis_run_items (
            idempotency_key,
            analysis_run_id,
            entity_path_id,
            item_ordinal
          )
          VALUES ('item-workflow-duplicate', $1, $2, 1)
        `,
        [runId, hierarchy.entityPathId]
      ),
      hasPostgresCode("23505")
    );

    const llmRunId = await insertReturningId(
      pool,
      `
        INSERT INTO llm_runs (
          idempotency_key,
          analysis_run_item_id
        )
        VALUES ('llm-workflow', $1)
        RETURNING llm_run_id
      `,
      [itemId],
      "llm_run_id"
    );
    const promptJobId = await insertReturningId(
      pool,
      `
        INSERT INTO prompt_jobs (
          idempotency_key,
          llm_run_id,
          prompt_type,
          prompt_version,
          prompt_text
        )
        VALUES ('prompt-workflow', $1, 'ranking', 'v1', 'Rank the evidence')
        RETURNING prompt_job_id
      `,
      [llmRunId],
      "prompt_job_id"
    );
    const providerJobId = await insertReturningId(
      pool,
      `
        INSERT INTO provider_jobs (
          idempotency_key,
          prompt_job_id,
          provider,
          model
        )
        VALUES ('provider-job-workflow', $1, 'mock', 'mock-v1')
        RETURNING provider_job_id
      `,
      [promptJobId],
      "provider_job_id"
    );
    const providerResultId = await insertReturningId(
      pool,
      `
        INSERT INTO provider_results (
          idempotency_key,
          provider_job_id,
          provider,
          status,
          provider_request_id,
          raw_response,
          parsed_response,
          latency_ms,
          received_at
        )
        VALUES (
          'provider-result-workflow',
          $1,
          'mock',
          'valid',
          'mock-request-1',
          '{"rank":1}',
          '{"rank":1}'::jsonb,
          10,
          now()
        )
        RETURNING provider_result_id
      `,
      [providerJobId],
      "provider_result_id"
    );

    await pool.query(
      `
        INSERT INTO token_usage (
          idempotency_key,
          provider_job_id,
          usage_kind,
          input_tokens,
          output_tokens,
          cached_tokens,
          reasoning_tokens
        )
        VALUES
          ('usage-estimated-workflow', $1, 'estimated', 100, 20, 0, 0),
          ('usage-actual-workflow', $1, 'actual', 90, 18, 10, 5)
      `,
      [providerJobId]
    );
    await pool.query(
      `
        INSERT INTO provider_scores (
          idempotency_key,
          provider_result_id,
          scoring_version,
          score,
          score_components
        )
        VALUES ('score-workflow', $1, 'v1', 88.5, '{"ranking":88.5}')
      `,
      [providerResultId]
    );
    await pool.query(
      `
        INSERT INTO reports (
          idempotency_key,
          analysis_run_id,
          report_version,
          status,
          report_data
        )
        VALUES ('report-workflow', $1, 'v1', 'completed', '{"score":88.5}')
      `,
      [runId]
    );
    await pool.query(
      `
        INSERT INTO outbox_events (
          event_key,
          aggregate_type,
          aggregate_id,
          event_type,
          payload
        )
        VALUES ('event-workflow', 'analysis_run', $1, 'analysis_run.created', '{}')
      `,
      [runId]
    );

    await assert.rejects(
      pool.query(
        "UPDATE provider_results SET raw_response = 'changed' WHERE provider_result_id = $1",
        [providerResultId]
      ),
      hasPostgresCode("23514")
    );
    await assert.rejects(
      pool.query(
        `
          INSERT INTO provider_results (
            idempotency_key,
            provider_job_id,
            provider,
            status,
            raw_response,
            parsed_response,
            latency_ms,
            received_at
          )
          VALUES ('provider-result-duplicate', $1, 'mock', 'valid', '{}', '{}', 1, now())
        `,
        [providerJobId]
      ),
      hasPostgresCode("23505")
    );
  });

  it("rejects edits to an already-applied migration", async () => {
    await appendFile(
      path.join(temporaryMigrationsDirectory, migrationFilenames[0] as string),
      "\n-- checksum mutation for test\n"
    );

    await assert.rejects(
      runMigrations({
        pool,
        migrationsDirectory: temporaryMigrationsDirectory
      }),
      /checksum does not match/
    );
  });
});

type OwnershipFixture = {
  memberUserId: string;
  nonmemberUserId: string;
  workspaceId: string;
  anonymousSessionId: string;
};

type HierarchyFixture = {
  domainId: string;
  categoryId: string;
  entityPathId: string;
};

async function createOwnershipFixture(pool: pg.Pool): Promise<OwnershipFixture> {
  const memberUserId = await insertReturningId(
    pool,
    `
      INSERT INTO users (email)
      VALUES ('member@example.com')
      RETURNING user_id
    `,
    [],
    "user_id"
  );
  const nonmemberUserId = await insertReturningId(
    pool,
    `
      INSERT INTO users (email)
      VALUES ('nonmember@example.com')
      RETURNING user_id
    `,
    [],
    "user_id"
  );
  const workspaceId = await insertReturningId(
    pool,
    `
      INSERT INTO workspaces (workspace_name, created_by_user_id)
      VALUES ('Test Workspace', $1)
      RETURNING workspace_id
    `,
    [memberUserId],
    "workspace_id"
  );
  await pool.query(
    `
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES ($1, $2, 'owner')
    `,
    [workspaceId, memberUserId]
  );
  const anonymousSessionId = await insertReturningId(
    pool,
    `
      INSERT INTO anonymous_sessions (token_hash, expires_at)
      VALUES ('anonymous-token-hash', now() + interval '1 day')
      RETURNING anonymous_session_id
    `,
    [],
    "anonymous_session_id"
  );

  return { memberUserId, nonmemberUserId, workspaceId, anonymousSessionId };
}

async function getOwnershipFixture(pool: pg.Pool): Promise<OwnershipFixture> {
  const result = await pool.query<OwnershipFixture>(`
    SELECT
      (SELECT user_id FROM users WHERE email = 'member@example.com') AS "memberUserId",
      (SELECT user_id FROM users WHERE email = 'nonmember@example.com') AS "nonmemberUserId",
      (SELECT workspace_id FROM workspaces WHERE workspace_name = 'Test Workspace') AS "workspaceId",
      (
        SELECT anonymous_session_id
        FROM anonymous_sessions
        WHERE token_hash = 'anonymous-token-hash'
      ) AS "anonymousSessionId"
  `);
  const fixture = result.rows[0];
  if (!fixture) {
    throw new Error("Ownership fixture not found");
  }
  return fixture;
}

async function createHierarchyFixture(pool: pg.Pool): Promise<HierarchyFixture> {
  const domainId = await insertReturningId(
    pool,
    `
      INSERT INTO domains (normalized_domain)
      VALUES ('hierarchy.example')
      RETURNING domain_id
    `,
    [],
    "domain_id"
  );
  const categoryId = await insertReturningId(
    pool,
    `
      INSERT INTO categories (category_name, normalized_name)
      VALUES ('Software', 'software')
      RETURNING category_id
    `,
    [],
    "category_id"
  );
  const entityPathId = await insertReturningId(
    pool,
    `
      INSERT INTO entity_paths (domain_id, category_id, path_type)
      VALUES ($1, $2, 'category')
      RETURNING entity_path_id
    `,
    [domainId, categoryId],
    "entity_path_id"
  );

  return { domainId, categoryId, entityPathId };
}

async function getDomainEntityPath(pool: pg.Pool) {
  const existing = await pool.query<{ entity_path_id: string }>(`
    SELECT entity_path_id
    FROM entity_paths
    ORDER BY entity_path_id
    LIMIT 1
  `);
  if (existing.rows[0]) {
    return { entityPathId: existing.rows[0].entity_path_id };
  }

  const domainId = await insertReturningId(
    pool,
    `
      INSERT INTO domains (normalized_domain)
      VALUES ('ownership.example')
      RETURNING domain_id
    `,
    [],
    "domain_id"
  );
  const entityPathId = await insertReturningId(
    pool,
    `
      INSERT INTO entity_paths (domain_id, path_type)
      VALUES ($1, 'domain')
      RETURNING entity_path_id
    `,
    [domainId],
    "entity_path_id"
  );
  return { entityPathId };
}

async function insertAnalysisRun(
  pool: pg.Pool,
  input: {
    idempotencyKey: string;
    anonymousSessionId: string | null;
    userId: string | null;
    workspaceId: string | null;
    entityPathId: string;
  }
) {
  return insertReturningId(
    pool,
    `
      INSERT INTO analysis_runs (
        idempotency_key,
        anonymous_session_id,
        user_id,
        workspace_id,
        starting_entity_path_id,
        request_payload
      )
      VALUES ($1, $2, $3, $4, $5, '{}')
      RETURNING analysis_run_id
    `,
    [
      input.idempotencyKey,
      input.anonymousSessionId,
      input.userId,
      input.workspaceId,
      input.entityPathId
    ],
    "analysis_run_id"
  );
}

async function insertReturningId(
  pool: pg.Pool,
  sql: string,
  values: unknown[],
  column: string
) {
  const result = await pool.query<Record<string, string>>(sql, values);
  const value = result.rows[0]?.[column];
  if (!value) {
    throw new Error(`Insert did not return ${column}`);
  }
  return value;
}

function hasPostgresCode(expectedCode: string) {
  return (error: unknown) => {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : null;
    assert.equal(code, expectedCode);
    return true;
  };
}
