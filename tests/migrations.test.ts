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
import type { PromptJobRow } from "../src/types/database.types.js";

const runDatabaseTests = process.env.RUN_MIGRATION_TESTS === "true";
const expectedTables = [
  "analysis_run_items",
  "analysis_runs",
  "anonymous_sessions",
  "brands",
  "brand_products",
  "budget_policies",
  "categories",
  "category_brands",
  "domain_categories",
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
  "product_use_contexts",
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
    pool = new pg.Pool({
      connectionString,
      max: 4,
      options: "-c search_path=migration_decoy,public"
    });

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
    await pool.query("DROP SCHEMA IF EXISTS migration_decoy CASCADE");
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("CREATE SCHEMA migration_decoy");

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
    await pool.query("CREATE TABLE public.legacy_probe (probe_id integer PRIMARY KEY)");
    await assert.rejects(
      runMigrations({
        pool,
        migrationsDirectory: temporaryMigrationsDirectory
      }),
      /Refusing to migrate non-empty public schema containing: legacy_probe/
    );
    await pool.query("DROP TABLE public.legacy_probe");

    const firstRun = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });
    assert.equal(firstRun.applied.length, 4);
    assert.equal(firstRun.skipped.length, 0);

    await pool.query(
      `
        INSERT INTO domains (normalized_domain, display_domain)
        VALUES ($1, 'RAW-UNTRUSTED-DISPLAY')
      `,
      [retainedDomain]
    );
    await pool.query(
      `
        WITH category AS (
          INSERT INTO categories (category_name, normalized_name)
          VALUES ('Historical Category', 'historical-category')
          RETURNING category_id
        )
        INSERT INTO entity_paths (domain_id, category_id, path_type)
        SELECT domain.domain_id, category.category_id, 'category'
        FROM domains AS domain
        CROSS JOIN category
        WHERE domain.normalized_domain = $1
      `,
      [retainedDomain]
    );

    const sourceDirectory = getDefaultMigrationsDirectory();
    const correctiveMigration = "013_seal_phase1_invariants.sql";
    const correctiveIndex = migrationFilenames.indexOf(correctiveMigration);
    if (correctiveIndex < 4) {
      throw new Error("Expected the Phase 1 corrective migration after the first four migrations");
    }

    for (const filename of migrationFilenames.slice(4, correctiveIndex)) {
      await cp(
        path.join(sourceDirectory, filename),
        path.join(temporaryMigrationsDirectory, filename)
      );
    }

    const baselineRun = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });
    assert.equal(baselineRun.applied.length, correctiveIndex - 4);
    assert.equal(baselineRun.skipped.length, 4);

    await cp(
      path.join(sourceDirectory, correctiveMigration),
      path.join(temporaryMigrationsDirectory, correctiveMigration)
    );
    const correctiveRun = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });
    assert.equal(correctiveRun.applied.length, 1);
    assert.equal(correctiveRun.skipped.length, correctiveIndex);

    const promptPlanningMigration =
      "017_allow_unrendered_prompt_jobs.sql";
    const promptPlanningIndex =
      migrationFilenames.indexOf(promptPlanningMigration);
    if (promptPlanningIndex <= correctiveIndex) {
      throw new Error("Expected migration 017 after the Phase 1 corrective migration");
    }

    for (const filename of migrationFilenames.slice(
      correctiveIndex + 1,
      promptPlanningIndex
    )) {
      await cp(
        path.join(sourceDirectory, filename),
        path.join(temporaryMigrationsDirectory, filename)
      );
    }
    const laterRun = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });
    assert.equal(
      laterRun.applied.length,
      promptPlanningIndex - correctiveIndex - 1
    );
    assert.equal(laterRun.skipped.length, correctiveIndex + 1);

    const historicalPrompt = await pool.query<{ prompt_job_id: string }>(`
      WITH anonymous_session AS (
        INSERT INTO anonymous_sessions (token_hash, expires_at)
        VALUES ('migration-017-anonymous', now() + interval '1 day')
        RETURNING anonymous_session_id
      ),
      analysis_run AS (
        INSERT INTO analysis_runs (
          idempotency_key,
          anonymous_session_id,
          starting_entity_path_id,
          request_payload
        )
        SELECT
          'migration-017-run',
          anonymous_session.anonymous_session_id,
          path.entity_path_id,
          '{}'::jsonb
        FROM anonymous_session
        CROSS JOIN LATERAL (
          SELECT entity_path_id FROM entity_paths ORDER BY entity_path_id LIMIT 1
        ) AS path
        RETURNING analysis_run_id, starting_entity_path_id
      ),
      analysis_item AS (
        INSERT INTO analysis_run_items (
          idempotency_key,
          analysis_run_id,
          entity_path_id,
          item_ordinal
        )
        SELECT
          'migration-017-item',
          analysis_run_id,
          starting_entity_path_id,
          0
        FROM analysis_run
        RETURNING analysis_run_item_id
      ),
      llm_run AS (
        INSERT INTO llm_runs (idempotency_key, analysis_run_item_id)
        SELECT 'migration-017-llm', analysis_run_item_id
        FROM analysis_item
        RETURNING llm_run_id
      )
      INSERT INTO prompt_jobs (
        idempotency_key,
        llm_run_id,
        prompt_type,
        prompt_version,
        prompt_text
      )
      SELECT
        'migration-017-rendered-prompt',
        llm_run_id,
        'ranking',
        'v1',
        'Existing rendered prompt'
      FROM llm_run
      RETURNING prompt_job_id
    `);
    assert.equal(historicalPrompt.rowCount, 1);

    await cp(
      path.join(sourceDirectory, promptPlanningMigration),
      path.join(temporaryMigrationsDirectory, promptPlanningMigration)
    );
    const promptPlanningRun = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });
    assert.equal(promptPlanningRun.applied.length, 1);
    assert.equal(promptPlanningRun.skipped.length, promptPlanningIndex);

    const retained = await pool.query<{
      normalized_domain: string;
      display_domain: string | null;
    }>(
      `
        SELECT normalized_domain, display_domain
        FROM domains
        WHERE normalized_domain = $1
      `,
      [retainedDomain]
    );
    assert.equal(retained.rows[0]?.normalized_domain, retainedDomain);
    assert.equal(retained.rows[0]?.display_domain, retainedDomain);
    const relationshipBackfill = await pool.query<{ count: string }>(
      "SELECT count(*) FROM domain_categories"
    );
    assert.equal(relationshipBackfill.rows[0]?.count, "0");
    const retainedPrompt = await pool.query<{ prompt_text: string | null }>(
      `
        SELECT prompt_text
        FROM prompt_jobs
        WHERE idempotency_key = 'migration-017-rendered-prompt'
      `
    );
    assert.equal(
      retainedPrompt.rows[0]?.prompt_text,
      "Existing rendered prompt"
    );

    await pool.query(`
      INSERT INTO provider_jobs (
        idempotency_key, prompt_job_id, provider, model
      )
      SELECT
        'migration-018-existing-provider',
        prompt_job_id,
        'mock',
        'mock-fast'
      FROM prompt_jobs
      WHERE idempotency_key = 'migration-017-rendered-prompt'
    `);
    const providerGuardMigration =
      "018_require_rendered_prompt_for_provider_jobs.sql";
    const providerGuardIndex =
      migrationFilenames.indexOf(providerGuardMigration);
    if (providerGuardIndex !== promptPlanningIndex + 1) {
      throw new Error("Expected migration 018 immediately after migration 017");
    }
    await cp(
      path.join(sourceDirectory, providerGuardMigration),
      path.join(temporaryMigrationsDirectory, providerGuardMigration)
    );
    const providerGuardRun = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });
    assert.equal(providerGuardRun.applied.length, 1);
    assert.equal(providerGuardRun.skipped.length, providerGuardIndex);
    const retainedProvider = await pool.query<{ count: string }>(
      `SELECT count(*) FROM provider_jobs
       WHERE idempotency_key = 'migration-018-existing-provider'`
    );
    assert.equal(retainedProvider.rows[0]?.count, "1");

    const modelPreferenceMigration =
      "019_add_analysis_run_model_preference.sql";
    const modelPreferenceIndex =
      migrationFilenames.indexOf(modelPreferenceMigration);
    if (modelPreferenceIndex !== providerGuardIndex + 1) {
      throw new Error("Expected migration 019 immediately after migration 018");
    }
    await cp(
      path.join(sourceDirectory, modelPreferenceMigration),
      path.join(temporaryMigrationsDirectory, modelPreferenceMigration)
    );
    const modelPreferenceRun = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });
    assert.equal(modelPreferenceRun.applied.length, 1);
    assert.equal(modelPreferenceRun.skipped.length, modelPreferenceIndex);
    const retainedRunPreference = await pool.query<{
      requested_provider: string | null;
      requested_model: string | null;
    }>(
      `SELECT requested_provider, requested_model
       FROM analysis_runs
       WHERE idempotency_key = 'migration-017-run'`
    );
    assert.deepEqual(retainedRunPreference.rows[0], {
      requested_provider: null,
      requested_model: null
    });
  });

  it("is a no-op on the second complete run", async () => {
    const result = await runMigrations({
      pool,
      migrationsDirectory: temporaryMigrationsDirectory
    });

    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, migrationFilenames.length);
  });

  it("creates exactly the 30 current production tables and no V5 tables", async () => {
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

    const decoyTables = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'migration_decoy'
        AND table_type = 'BASE TABLE'
    `);
    assert.deepEqual(decoyTables.rows, []);
  });

  it("allows null or nonblank prompt text and rejects blank rendered text", async () => {
    const nullableContract: PromptJobRow["prompt_text"] = null;
    assert.equal(nullableContract, null);

    const llmRun = await pool.query<{ llm_run_id: string }>(
      `
        SELECT llm_run_id
        FROM llm_runs
        WHERE idempotency_key = 'migration-017-llm'
      `
    );
    const llmRunId = llmRun.rows[0]!.llm_run_id;

    const nullPrompt = await pool.query<{ prompt_job_id: string }>(
      `
        INSERT INTO prompt_jobs (
          idempotency_key, llm_run_id, prompt_type, prompt_version, prompt_text
        )
        VALUES ('migration-017-null', $1, 'competitor', 'v1', NULL)
        RETURNING prompt_job_id
      `,
      [llmRunId]
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO provider_jobs (
           idempotency_key, prompt_job_id, provider, model
         )
         VALUES ('migration-018-unrendered-provider', $1, 'mock', 'mock-fast')`,
        [nullPrompt.rows[0]!.prompt_job_id]
      ),
      hasPostgresCode("23514")
    );

    for (const [key, type, text] of [
      ["migration-017-empty", "visibility", ""],
      ["migration-017-whitespace", "price_range", "   "]
    ]) {
      await assert.rejects(
        pool.query(
          `
            INSERT INTO prompt_jobs (
              idempotency_key,
              llm_run_id,
              prompt_type,
              prompt_version,
              prompt_text
            )
            VALUES ($1, $2, $3, 'v1', $4)
          `,
          [key, llmRunId, type, text]
        ),
        hasPostgresCode("23514")
      );
    }
    const nonblankPrompt = await pool.query<{ prompt_job_id: string }>(
      `
        INSERT INTO prompt_jobs (
          idempotency_key, llm_run_id, prompt_type, prompt_version, prompt_text
        )
        VALUES (
          'migration-017-nonblank',
          $1,
          'pros_cons',
          'v1',
          'Real prompt text'
        )
        RETURNING prompt_job_id
      `,
      [llmRunId]
    );
    await pool.query(
      `INSERT INTO provider_jobs (
         idempotency_key, prompt_job_id, provider, model
       )
       VALUES ('migration-018-rendered-provider', $1, 'mock', 'mock-fast')`,
      [nonblankPrompt.rows[0]!.prompt_job_id]
    );
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
      pool.query(
        `UPDATE analysis_runs
         SET requested_provider = 'mock', requested_model = 'mock-fast'
         WHERE analysis_run_id = $1`,
        [anonymousRun]
      ),
      hasPostgresCode("23514")
    );

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

    await assert.rejects(
      insertAnalysisRun(pool, {
        idempotencyKey: "run-unclaimed-session",
        anonymousSessionId: ownership.anonymousSessionId,
        userId: ownership.memberUserId,
        workspaceId: ownership.workspaceId,
        entityPathId: hierarchy.entityPathId
      }),
      hasPostgresCode("23514")
    );

    await pool.query(
      `
        UPDATE anonymous_sessions
        SET claimed_by_user_id = $2,
            claimed_workspace_id = $3,
            claimed_at = now()
        WHERE anonymous_session_id = $1
      `,
      [
        ownership.anonymousSessionId,
        ownership.memberUserId,
        ownership.workspaceId
      ]
    );

    await pool.query(
      `
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES ($1, $2, 'member')
      `,
      [ownership.workspaceId, ownership.nonmemberUserId]
    );
    const otherWorkspaceId = await insertReturningId(
      pool,
      `
        INSERT INTO workspaces (workspace_name, created_by_user_id)
        VALUES ('Other Workspace', $1)
        RETURNING workspace_id
      `,
      [ownership.memberUserId],
      "workspace_id"
    );
    await pool.query(
      `
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES ($1, $2, 'owner')
      `,
      [otherWorkspaceId, ownership.memberUserId]
    );

    await assert.rejects(
      insertAnalysisRun(pool, {
        idempotencyKey: "run-mismatched-claimed-user",
        anonymousSessionId: ownership.anonymousSessionId,
        userId: ownership.nonmemberUserId,
        workspaceId: ownership.workspaceId,
        entityPathId: hierarchy.entityPathId
      }),
      hasPostgresCode("23514")
    );
    await assert.rejects(
      insertAnalysisRun(pool, {
        idempotencyKey: "run-mismatched-claimed-workspace",
        anonymousSessionId: ownership.anonymousSessionId,
        userId: ownership.memberUserId,
        workspaceId: otherWorkspaceId,
        entityPathId: hierarchy.entityPathId
      }),
      hasPostgresCode("23514")
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

    await assert.rejects(
      pool.query(
        `
          UPDATE anonymous_sessions
          SET claimed_by_user_id = $2
          WHERE anonymous_session_id = $1
        `,
        [ownership.anonymousSessionId, ownership.nonmemberUserId]
      ),
      hasPostgresCode("23514")
    );

    const loggedInRun = await insertAnalysisRun(pool, {
      idempotencyKey: "run-origin-cannot-be-added",
      anonymousSessionId: null,
      userId: ownership.memberUserId,
      workspaceId: ownership.workspaceId,
      entityPathId: hierarchy.entityPathId
    });
    await assert.rejects(
      pool.query(
        `UPDATE analysis_runs
         SET requested_provider = 'mock'
         WHERE analysis_run_id = $1`,
        [loggedInRun]
      ),
      hasPostgresCode("23514")
    );
    await pool.query(
      `UPDATE analysis_runs
       SET requested_provider = 'mock', requested_model = 'mock-quality'
       WHERE analysis_run_id = $1`,
      [loggedInRun]
    );
    await assert.rejects(
      pool.query(
        `UPDATE analysis_runs
         SET requested_provider = 'mock', requested_model = 'arbitrary'
         WHERE analysis_run_id = $1`,
        [loggedInRun]
      ),
      hasPostgresCode("23514")
    );
    await assert.rejects(
      pool.query(
        `UPDATE analysis_runs
         SET requested_provider = 'openai', requested_model = 'gpt-4o-mini'
         WHERE analysis_run_id = $1`,
        [loggedInRun]
      ),
      hasPostgresCode("23514")
    );
    await assert.rejects(
      pool.query(
        `
          UPDATE analysis_runs
          SET anonymous_session_id = $2
          WHERE analysis_run_id = $1
        `,
        [loggedInRun, ownership.anonymousSessionId]
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
    await assert.rejects(
      pool.query(
        `
          INSERT INTO llm_runs (
            idempotency_key,
            analysis_run_item_id,
            run_key
          )
          VALUES ('llm-workflow-duplicate', $1, 'primary')
        `,
        [itemId]
      ),
      hasPostgresCode("23505")
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
    await assert.rejects(
      pool.query(
        `
          INSERT INTO prompt_jobs (
            idempotency_key,
            llm_run_id,
            prompt_type,
            prompt_version,
            prompt_text
          )
          VALUES (
            'prompt-workflow-duplicate',
            $1,
            'ranking',
            'v1',
            'Duplicate prompt'
          )
        `,
        [llmRunId]
      ),
      hasPostgresCode("23505")
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
    await assert.rejects(
      pool.query(
        `
          INSERT INTO provider_jobs (
            idempotency_key,
            prompt_job_id,
            provider,
            model
          )
          VALUES ('provider-job-workflow-duplicate', $1, 'mock', 'mock-v1')
        `,
        [promptJobId]
      ),
      hasPostgresCode("23505")
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
    await assert.rejects(
      pool.query(
        `
          UPDATE token_usage
          SET input_tokens = input_tokens + 1
          WHERE idempotency_key = 'usage-estimated-workflow'
        `
      ),
      hasPostgresCode("23514")
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
    await assert.rejects(
      pool.query(
        `
          INSERT INTO provider_scores (
            idempotency_key,
            provider_result_id,
            scoring_version,
            score
          )
          VALUES ('score-workflow-duplicate', $1, 'v1', 50)
        `,
        [providerResultId]
      ),
      hasPostgresCode("23505")
    );
    await assert.rejects(
      pool.query(
        `
          UPDATE provider_scores
          SET score = 1
          WHERE idempotency_key = 'score-workflow'
        `
      ),
      hasPostgresCode("23514")
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
    await assert.rejects(
      pool.query(
        `
          INSERT INTO reports (
            idempotency_key,
            analysis_run_id,
            report_version,
            status,
            report_data
          )
          VALUES ('report-workflow-duplicate', $1, 'v1', 'completed', '{}')
        `,
        [runId]
      ),
      hasPostgresCode("23505")
    );
    await assert.rejects(
      pool.query(
        "DELETE FROM reports WHERE idempotency_key = 'report-workflow'"
      ),
      hasPostgresCode("23514")
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
        `
          INSERT INTO outbox_events (
            event_key,
            aggregate_type,
            aggregate_id,
            event_type,
            payload
          )
          VALUES ('event-workflow', 'analysis_run', $1, 'duplicate', '{}')
        `,
        [runId]
      ),
      hasPostgresCode("23505")
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
        "DELETE FROM provider_results WHERE provider_result_id = $1",
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
