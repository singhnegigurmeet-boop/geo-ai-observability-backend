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
  "analysis_run_requested_categories",
  "analysis_runs",
  "anonymous_sessions",
  "brand_products",
  "brands",
  "budget_policies",
  "categories",
  "category_brands",
  "domain_categories",
  "domain_category_classification_jobs",
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
  "scheduler_job_requested_categories",
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

  it("creates exactly the 34 final production tables", async () => {
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
      enums: "26",
      foreign_keys: "57",
      unique_constraints: "44",
      check_constraints: "112",
      indexes: "138",
      triggers: "26"
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
           idempotency_key, starting_entity_path_id, category_selection_mode,
           prompt_depth, prompt_policy_version, request_payload
         ) VALUES (
           'invalid-owner', $1, 'all', 'weak', 'geo-prompt-policy-v1', '{}'
         )`,
        [path.rows[0]!.id]
      ),
      hasCode("23514")
    );
  });

  it("freezes the normalized provider set after run creation", async () => {
    const fixture = await seedAnonymousRun(pool);
    const frozen = await pool.query<{ id: string }>(
       `INSERT INTO analysis_run_provider_models (
         analysis_run_id, provider, model, model_profile_version, ordinal
       ) VALUES ($1, 'mock', 'mock-fast', 'mock-fast-v1', 0)
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
           idempotency_key, job_kind, prompt_job_id, provider, model,
           response_contract_version, provider_instruction_profile,
           model_profile_version, structured_output_mode, request_payload
         ) VALUES (
           'unrendered-provider', 'normal_prompt', $1, 'mock', 'mock-fast',
           'geo-response-contract-v1', 'mock-json-v1',
           'mock-fast-v1', 'native_json_schema', '{}'
         )`,
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
        "analysis_run_requested_categories",
        "provider_results",
        "provider_scores",
        "reports",
        "scheduler_job_requested_categories",
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

  it("indexes exact failure-record report-finality lookups", async () => {
    const index = await pool.query<{
      indexdef: string;
    }>(
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'failure_records'
         AND indexname = 'failure_records_report_finality_idx'`
    );
    assert.equal(index.rows.length, 1);
    assert.match(
      index.rows[0]!.indexdef,
      /\(aggregate_type, aggregate_id, queue_name, attempt_number DESC\)/
    );
    assert.match(
      index.rows[0]!.indexdef,
      /WHERE \(\(aggregate_type IS NOT NULL\) AND \(aggregate_id IS NOT NULL\)\)/
    );
    const existing = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'failure_records'
         AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [[
        "failure_records_aggregate_status_idx",
        "failure_records_open_queue_idx"
      ]]
    );
    assert.deepEqual(
      existing.rows.map((row) => row.indexname),
      [
        "failure_records_aggregate_status_idx",
        "failure_records_open_queue_idx"
      ]
    );
  });

  it("protects the complete frozen classification execution identity", async () => {
    const trigger = await pool.query<{
      action_statement: string;
      action_timing: string;
      event_manipulation: string;
    }>(
      `SELECT action_statement, action_timing, event_manipulation
       FROM information_schema.triggers
       WHERE trigger_schema = 'public'
         AND event_object_table =
             'domain_category_classification_jobs'
         AND trigger_name =
             'domain_category_classification_jobs_identity_trigger'`
    );
    assert.deepEqual(trigger.rows, [{
      action_statement:
        "EXECUTE FUNCTION preserve_classification_job_execution_identity()",
      action_timing: "BEFORE",
      event_manipulation: "UPDATE"
    }]);
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
       category_selection_mode, prompt_depth, prompt_policy_version,
       request_payload
     ) VALUES (
       'schema-run', $1, $2, 'all', 'weak', 'geo-prompt-policy-v1', '{}'
     )
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
       idempotency_key, llm_run_id, prompt_type, prompt_depth,
       business_prompt_version, response_contract_version, prompt_text
     ) VALUES (
       'schema-prompt', $1, 'visibility', 'weak',
       'geo-business-prompt-v1', 'geo-response-contract-v1', $2
     )
     RETURNING prompt_job_id AS id`,
    [llm.rows[0]!.id, promptText]
  );
  return { promptId: prompt.rows[0]!.id };
}
