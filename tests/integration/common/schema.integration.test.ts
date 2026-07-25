import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import {
  createIntegrationPool,
  resetTestSchema
} from "../../support/integration-environment.js";
import {
  getDefaultMigrationsDirectory,
  loadMigrationFiles,
  runMigrations
} from "../../../src/common/database/migration-runner.js";

const enabled = process.env.RUN_SCHEMA_TESTS === "true";
const expectedTables = [
  "analysis_run_items",
  "analysis_run_provider_models",
  "analysis_runs",
  "anonymous_sessions",
  "brand_products",
  "brands",
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
  "product_use_contexts",
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
] as const;

describe("Final V6 baseline schema", { skip: !enabled, concurrency: 1 }, () => {
  const pool = createIntegrationPool();

  before(async () => {
    await resetTestSchema(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE
        workspace_role_change_requests, workspace_members, workspaces,
        user_sessions, users, anonymous_sessions, scheduler_jobs,
        notifications, failure_records, outbox_events, reports,
        provider_scores, token_usage, budget_policies, provider_results,
        provider_jobs, prompt_jobs, llm_runs, analysis_run_items,
        analysis_run_provider_models, analysis_runs, entity_paths,
        product_use_contexts, brand_products, category_brands,
        domain_categories, use_contexts, products, brands, categories, domains
      RESTART IDENTITY CASCADE
    `);
  });

  it("contains exactly one checksummed migration ledger entry", async () => {
    const files = await loadMigrationFiles(getDefaultMigrationsDirectory());
    assert.deepEqual(files.map((file) => file.filename), [
      "001_v6_final_baseline.sql"
    ]);
    const ledger = await pool.query<{
      version: number;
      filename: string;
      checksum: string;
    }>(
      `SELECT version, filename, checksum
       FROM geo_meta.schema_migrations
       ORDER BY version`
    );
    assert.deepEqual(
      ledger.rows.map(({ version, filename, checksum }) => ({
        version,
        filename,
        checksum
      })),
      [{
        version: 1,
        filename: files[0]!.filename,
        checksum: files[0]!.checksum
      }]
    );
  });

  it("creates exactly the 31 final production tables", async () => {
    const result = await pool.query<{ tablename: string }>(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename`
    );
    assert.deepEqual(
      result.rows.map((row) => row.tablename),
      [...expectedTables].sort()
    );
  });

  it("creates the complete final constraint, index, enum, and trigger catalog", async () => {
    const result = await pool.query<{
      enums: string;
      foreign_keys: string;
      unique_constraints: string;
      check_constraints: string;
      indexes: string;
      triggers: string;
    }>(`
      SELECT
        (SELECT count(*) FROM pg_type type
         JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
         WHERE namespace.nspname = 'public' AND type.typtype = 'e') AS enums,
        (SELECT count(*) FROM pg_constraint constraint_row
         JOIN pg_namespace namespace ON namespace.oid = constraint_row.connamespace
         WHERE namespace.nspname = 'public' AND constraint_row.contype = 'f') AS foreign_keys,
        (SELECT count(*) FROM pg_constraint constraint_row
         JOIN pg_namespace namespace ON namespace.oid = constraint_row.connamespace
         WHERE namespace.nspname = 'public' AND constraint_row.contype = 'u') AS unique_constraints,
        (SELECT count(*) FROM pg_constraint constraint_row
         JOIN pg_namespace namespace ON namespace.oid = constraint_row.connamespace
         WHERE namespace.nspname = 'public' AND constraint_row.contype = 'c') AS check_constraints,
        (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public') AS indexes,
        (SELECT count(*) FROM information_schema.triggers
         WHERE trigger_schema = 'public') AS triggers
    `);
    assert.deepEqual(result.rows[0], {
      enums: "20",
      foreign_keys: "49",
      unique_constraints: "39",
      check_constraints: "94",
      indexes: "121",
      triggers: "20"
    });
  });

  it("contains only providerModels as analysis provider request state", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'analysis_runs'
         AND column_name LIKE 'requested_%'`
    );
    assert.deepEqual(columns.rows, []);
  });

  it("enforces final ownership shapes", async () => {
    const domain = await pool.query<{ id: string }>(
      `INSERT INTO domains (normalized_domain)
       VALUES ('schema-ownership.example')
       RETURNING domain_id AS id`
    );
    const path = await pool.query<{ id: string }>(
      `INSERT INTO entity_paths (path_type, domain_id)
       VALUES ('domain', $1)
       RETURNING entity_path_id AS id`,
      [domain.rows[0]!.id]
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO analysis_runs (
           idempotency_key, starting_entity_path_id, request_payload
         ) VALUES ('invalid-owner', $1, '{}')`,
        [path.rows[0]!.id]
      ),
      hasCode("23514")
    );
  });

  it("freezes the normalized provider set after run creation", async () => {
    const fixture = await seedAnonymousRun(pool);
    const frozen = await pool.query<{ id: string }>(
      `INSERT INTO analysis_run_provider_models (
         analysis_run_id, provider, model, ordinal
       ) VALUES ($1, 'mock', 'mock-fast', 0)
       RETURNING analysis_run_provider_model_id AS id`,
      [fixture.runId]
    );
    await assert.rejects(
      pool.query(
        `UPDATE analysis_run_provider_models
         SET model = 'mock-standard'
         WHERE analysis_run_provider_model_id = $1`,
        [frozen.rows[0]!.id]
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("analysis_run_provider_models rows are immutable")
    );
  });

  it("requires rendering before provider fan-out", async () => {
    const fixture = await seedPrompt(pool, null);
    await assert.rejects(
      pool.query(
        `INSERT INTO provider_jobs (
           idempotency_key, prompt_job_id, provider, model, request_payload
         ) VALUES ('unrendered-provider', $1, 'mock', 'mock-fast', '{}')`,
        [fixture.promptId]
      ),
      hasCode("23514")
    );
  });

  it("keeps result, score, and report rows immutable", async () => {
    const triggerTables = await pool.query<{ event_object_table: string }>(
      `SELECT DISTINCT event_object_table
       FROM information_schema.triggers
       WHERE trigger_schema = 'public'
         AND action_statement LIKE '%reject_immutable_evidence_mutation%'
       ORDER BY event_object_table`
    );
    assert.deepEqual(
      triggerTables.rows.map((row) => row.event_object_table),
      [
        "analysis_run_provider_models",
        "provider_results",
        "provider_scores",
        "reports",
        "token_usage"
      ]
    );
  });

  it("enforces report revision, scoring, scheduler, notification, and outbox identities", async () => {
    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname
       FROM pg_constraint constraint_row
       JOIN pg_namespace namespace ON namespace.oid = constraint_row.connamespace
       WHERE namespace.nspname = 'public'
         AND conname = ANY($1::text[])
       ORDER BY conname`,
      [[
        "notifications_idempotency_key_key",
        "outbox_events_event_key_key",
        "provider_scores_result_version_unique",
        "reports_run_version_revision_unique",
        "scheduler_jobs_idempotency_key_key"
      ]]
    );
    assert.equal(constraints.rows.length, 5);
  });

  it("is a no-op when the exact baseline is already applied", async () => {
    const result = await runMigrations({
      pool,
      migrationsDirectory: getDefaultMigrationsDirectory()
    });
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
  });
});

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

async function seedAnonymousRun(
  pool: ReturnType<typeof createIntegrationPool>
) {
  const session = await pool.query<{ id: string }>(
    `INSERT INTO anonymous_sessions (token_hash, expires_at)
     VALUES ('schema-session', now() + interval '1 hour')
     RETURNING anonymous_session_id AS id`
  );
  const domain = await pool.query<{ id: string }>(
    `INSERT INTO domains (normalized_domain)
     VALUES ('schema-run.example')
     RETURNING domain_id AS id`
  );
  const path = await pool.query<{ id: string }>(
    `INSERT INTO entity_paths (path_type, domain_id)
     VALUES ('domain', $1)
     RETURNING entity_path_id AS id`,
    [domain.rows[0]!.id]
  );
  const run = await pool.query<{ id: string }>(
    `INSERT INTO analysis_runs (
       idempotency_key, anonymous_session_id, starting_entity_path_id,
       request_payload
     ) VALUES ('schema-run', $1, $2, '{}')
     RETURNING analysis_run_id AS id`,
    [session.rows[0]!.id, path.rows[0]!.id]
  );
  return { runId: run.rows[0]!.id, pathId: path.rows[0]!.id };
}

async function seedPrompt(
  pool: ReturnType<typeof createIntegrationPool>,
  promptText: string | null
) {
  const run = await seedAnonymousRun(pool);
  const item = await pool.query<{ id: string }>(
    `INSERT INTO analysis_run_items (
       idempotency_key, analysis_run_id, entity_path_id, item_ordinal
     ) VALUES ('schema-item', $1, $2, 0)
     RETURNING analysis_run_item_id AS id`,
    [run.runId, run.pathId]
  );
  const llm = await pool.query<{ id: string }>(
    `INSERT INTO llm_runs (idempotency_key, analysis_run_item_id)
     VALUES ('schema-llm', $1)
     RETURNING llm_run_id AS id`,
    [item.rows[0]!.id]
  );
  const prompt = await pool.query<{ id: string }>(
    `INSERT INTO prompt_jobs (
       idempotency_key, llm_run_id, prompt_type, prompt_version, prompt_text
     ) VALUES ('schema-prompt', $1, 'visibility', 'v1_light', $2)
     RETURNING prompt_job_id AS id`,
    [llm.rows[0]!.id, promptText]
  );
  return { promptId: prompt.rows[0]!.id };
}
