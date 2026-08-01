import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
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
  "domains",
  "entity_paths",
  "failure_records",
  "hierarchy_discovery_jobs",
  "hierarchy_discovery_relationships",
  "llm_runs",
  "notifications",
  "outbox_events",
  "pre_analysis_requests",
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
        hierarchy_discovery_relationships, provider_jobs,
        hierarchy_discovery_jobs, prompt_jobs, llm_runs, analysis_run_items,
        analysis_run_provider_models, analysis_runs, entity_paths,
        pre_analysis_requests,
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

  it("creates exactly the 36 final production tables", async () => {
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
      enums: "29",
      foreign_keys: "77",
      unique_constraints: "48",
      check_constraints: "125",
      indexes: "148",
      triggers: "37"
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
        "hierarchy_discovery_relationships",
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

  it("protects the complete frozen discovery execution identity", async () => {
    const trigger = await pool.query<{
      action_statement: string;
      action_timing: string;
      event_manipulation: string;
    }>(
      `SELECT action_statement, action_timing, event_manipulation
       FROM information_schema.triggers
       WHERE trigger_schema = 'public'
         AND event_object_table =
             'hierarchy_discovery_jobs'
         AND trigger_name =
             'hierarchy_discovery_jobs_identity_trigger'`
    );
    assert.deepEqual(trigger.rows, [{
      action_statement:
        "EXECUTE FUNCTION preserve_hierarchy_discovery_job_execution_identity()",
      action_timing: "BEFORE",
      event_manipulation: "UPDATE"
    }]);
  });

  it("behaviorally freezes every discovery identity field while allowing rendering and lifecycle", async () => {
    const fixture = await seedDiscoveryHierarchy(pool, "identity");
    const jobId = await seedDiscoveryJob(pool, fixture, "use_context", "identity", {
      rendered: false,
      fallback: true
    });

    await pool.query(
      `UPDATE hierarchy_discovery_jobs
       SET rendered_prompt='rendered A', status='processing', started_at=now(), updated_at=now()
       WHERE hierarchy_discovery_job_id=$1`,
      [jobId]
    );
    await pool.query(
      `UPDATE hierarchy_discovery_jobs
       SET status='paused_budget', error_code='PAUSED', error_message='paused', updated_at=now()
       WHERE hierarchy_discovery_job_id=$1`,
      [jobId]
    );
    await pool.query(
      `UPDATE hierarchy_discovery_jobs
       SET status='processing', error_code=NULL, error_message=NULL, started_at=now(), updated_at=now()
       WHERE hierarchy_discovery_job_id=$1`,
      [jobId]
    );

    const mutations = [
      ["idempotency_key", "idempotency_key=idempotency_key || '-changed'"],
      ["request", `pre_analysis_request_id=${fixture.otherRequestId}`],
      ["domain", `domain_id=${fixture.other.domainId}`],
      ["stage", "stage='product'"],
      ["domain-category", `domain_category_id=${fixture.other.domainCategoryId}`],
      ["category-brand", `category_brand_id=${fixture.other.categoryBrandId}`],
      ["brand-product", `brand_product_id=${fixture.other.brandProductId}`],
      ["branch key", `branch_key='${"a".repeat(64)}'`],
      ["candidate hash", `candidate_set_hash='${"b".repeat(64)}'`],
      ["candidate count", "candidate_count=candidate_count+1"],
      ["primary provider", "primary_provider='openai'"],
      ["primary model", "primary_model='mock-standard'"],
      ["fallback provider", "fallback_provider='openai'"],
      ["fallback model", "fallback_model='mock-quality'"],
      ["model profile", "model_profile_version='changed-profile'"],
      ["discovery policy", "discovery_policy_version='changed-policy'"],
      ["prompt version", "prompt_version='changed-prompt'"],
      ["response contract", "response_contract_version='changed-contract'"],
      ["instruction profile", "provider_instruction_profile='changed-instruction'"],
      ["structured mode", "structured_output_mode='changed-mode'"],
      ["input payload", `input_payload='{"changed":true}'::jsonb`],
      ["created timestamp", "created_at=created_at + interval '1 second'"],
      ["rendered prompt", "rendered_prompt='rendered B'"]
    ] as const;
    for (const [label, assignment] of mutations) {
      await assert.rejects(
        pool.query(
          `UPDATE hierarchy_discovery_jobs SET ${assignment}
           WHERE hierarchy_discovery_job_id=$1`,
          [jobId]
        ),
        hasCode("23514"),
        label
      );
    }
  });

  it("enforces coherent discovery branch ancestry for every stage", async () => {
    const fixture = await seedDiscoveryHierarchy(pool, "branches");
    for (const stage of ["category", "brand", "product", "use_context"] as const) {
      assert.ok(await seedDiscoveryJob(pool, fixture, stage, `valid-${stage}`));
    }

    await assert.rejects(
      seedDiscoveryJob(pool, fixture, "category", "wrong-request-domain", {
        domainId: fixture.other.domainId
      }),
      hasCode("23514")
    );
    await assert.rejects(
      seedDiscoveryJob(pool, fixture, "brand", "wrong-domain-category", {
        domainCategoryId: fixture.other.domainCategoryId
      }),
      hasCode("23514")
    );
    await assert.rejects(
      seedDiscoveryJob(pool, fixture, "product", "wrong-category-brand", {
        categoryBrandId: fixture.other.categoryBrandId
      }),
      hasCode("23514")
    );
    await assert.rejects(
      seedDiscoveryJob(pool, fixture, "use_context", "wrong-brand-product", {
        brandProductId: fixture.other.brandProductId
      }),
      hasCode("23514")
    );
  });

  it("enforces typed coherent immutable lineage and same-job provider evidence", async () => {
    const fixture = await seedDiscoveryHierarchy(pool, "lineage");
    const categoryJob = await seedDiscoveryJob(pool, fixture, "category", "category", { rendered: true });
    const brandJob = await seedDiscoveryJob(pool, fixture, "brand", "brand", { rendered: true });
    const productJob = await seedDiscoveryJob(pool, fixture, "product", "product", { rendered: true });
    const contextJob = await seedDiscoveryJob(pool, fixture, "use_context", "context", { rendered: true });
    const categoryJobB = await seedDiscoveryJob(pool, fixture, "category", "category-b", { rendered: true });

    const wrongTypes = [
      [categoryJob, "category_brand_id", fixture.categoryBrandId],
      [brandJob, "brand_product_id", fixture.brandProductId],
      [productJob, "domain_category_id", fixture.domainCategoryId],
      [contextJob, "brand_product_id", fixture.brandProductId]
    ] as const;
    for (const [jobId, column, edgeId] of wrongTypes) {
      await assert.rejects(
        insertLineage(pool, jobId, column, edgeId, null),
        hasCode("23514")
      );
    }

    const wrongBranches = [
      [categoryJob, "domain_category_id", fixture.other.domainCategoryId],
      [brandJob, "category_brand_id", fixture.other.categoryBrandId],
      [productJob, "brand_product_id", fixture.other.brandProductId],
      [contextJob, "product_use_context_id", fixture.other.productUseContextId]
    ] as const;
    for (const [jobId, column, edgeId] of wrongBranches) {
      await assert.rejects(
        insertLineage(pool, jobId, column, edgeId, null),
        hasCode("23514")
      );
    }

    const providerJobA = await seedDiscoveryProviderJob(pool, categoryJob, 0, "mock", "mock-fast", "lineage-a");
    const resultA = await seedInvalidProviderResult(pool, providerJobA, "mock", "lineage-a");
    const providerJobB = await seedDiscoveryProviderJob(pool, categoryJobB, 0, "mock", "mock-fast", "lineage-b");
    await seedInvalidProviderResult(pool, providerJobB, "mock", "lineage-b");

    const lineageId = await insertLineage(
      pool,
      categoryJob,
      "domain_category_id",
      fixture.domainCategoryId,
      resultA
    );
    await assert.rejects(
      insertLineage(pool, categoryJobB, "domain_category_id", fixture.domainCategoryId, resultA),
      hasCode("23514")
    );
    await assert.rejects(
      pool.query(
        "UPDATE hierarchy_discovery_relationships SET reason='changed' WHERE hierarchy_discovery_relationship_id=$1",
        [lineageId]
      ),
      hasCode("23514")
    );
    await assert.rejects(
      pool.query(
        "DELETE FROM hierarchy_discovery_relationships WHERE hierarchy_discovery_relationship_id=$1",
        [lineageId]
      ),
      hasCode("23514")
    );

    assert.ok(await insertLineage(pool, brandJob, "category_brand_id", fixture.categoryBrandId, null));
    assert.ok(await insertLineage(pool, productJob, "brand_product_id", fixture.brandProductId, null));
    assert.ok(await insertLineage(pool, contextJob, "product_use_context_id", fixture.productUseContextId, null));
  });

  it("enforces frozen primary and exact fallback provider attempt identity", async () => {
    const fixture = await seedDiscoveryHierarchy(pool, "attempts");
    const job = await seedDiscoveryJob(pool, fixture, "category", "with-fallback", {
      rendered: true,
      fallback: true
    });

    await assert.rejects(
      seedDiscoveryProviderJob(pool, job, 0, "mock", "mock-standard", "wrong-primary"),
      hasCode("23514")
    );
    const primary = await seedDiscoveryProviderJob(pool, job, 0, "mock", "mock-fast", "primary");
    assert.ok(primary);
    const fallback = await seedDiscoveryProviderJob(pool, job, 1, "mock", "mock-standard", "fallback");
    assert.ok(fallback);

    const arbitraryJob = await seedDiscoveryJob(pool, fixture, "category", "arbitrary", {
      rendered: true,
      fallback: true
    });
    await assert.rejects(
      seedDiscoveryProviderJob(pool, arbitraryJob, 1, "openai", "gpt-4o-mini", "arbitrary-fallback"),
      hasCode("23514")
    );
    const noFallbackJob = await seedDiscoveryJob(pool, fixture, "category", "no-fallback", {
      rendered: true,
      fallback: false
    });
    await assert.rejects(
      seedDiscoveryProviderJob(pool, noFallbackJob, 1, "mock", "mock-standard", "missing-fallback"),
      hasCode("23514")
    );

    const mutableBoundaryJob = await seedDiscoveryJob(pool, fixture, "category", "attempt-freeze", {
      rendered: true,
      fallback: true
    });
    const dispatched = await seedDiscoveryProviderJob(pool, mutableBoundaryJob, 0, "mock", "mock-fast", "dispatched");
    await pool.query("UPDATE provider_jobs SET status='queued' WHERE provider_job_id=$1", [dispatched]);
    await assert.rejects(
      pool.query(
        "UPDATE provider_jobs SET discovery_attempt=1,provider='mock',model='mock-standard' WHERE provider_job_id=$1",
        [dispatched]
      ),
      hasCode("23514")
    );

    const prompt = await seedPrompt(pool, "normal rendered prompt");
    await assert.rejects(
      pool.query(
        `INSERT INTO provider_jobs
          (idempotency_key,job_kind,prompt_job_id,discovery_attempt,provider,model,
           response_contract_version,provider_instruction_profile,model_profile_version,
           structured_output_mode,request_payload)
         VALUES ('normal-nonzero','normal_prompt',$1,1,'mock','mock-fast',
           'geo-response-contract-v1','mock-json-v1','mock-fast-v1','json_schema','{}')`,
        [prompt.promptId]
      ),
      hasCode("23514")
    );
  });

  it("freezes accepted pre-analysis intent and permits legitimate lifecycle/link preparation", async () => {
    const fixture = await seedDiscoveryHierarchy(pool, "request-identity");
    const requestId = fixture.requestId;
    const mutations = [
      "idempotency_key=idempotency_key || '-changed'",
      "anonymous_session_id=NULL",
      `domain_id=${fixture.other.domainId}`,
      `starting_entity_path_id=${fixture.other.pathId}`,
      "category_selection_mode='selected'",
      "prompt_depth='medium'",
      "source='scheduled'",
      `request_payload='{"changed":true}'::jsonb`,
      `canonical_request_hash='${"c".repeat(64)}'`,
      `discovery_compatibility_hash='${"d".repeat(64)}'`,
      "created_at=created_at + interval '1 second'"
    ];
    for (const assignment of mutations) {
      await assert.rejects(
        pool.query(`UPDATE pre_analysis_requests SET ${assignment} WHERE pre_analysis_request_id=$1`, [requestId]),
        (error: unknown) => error instanceof Error && error.message.includes("accepted identity is immutable")
      );
    }

    await pool.query(
      `UPDATE pre_analysis_requests
       SET status='checking_hierarchy',discovery_status='checking',
           discovery_coverage='{"checked":true}',error_code='SAFE',error_message='safe',
           started_at=now(),updated_at=now()
       WHERE pre_analysis_request_id=$1`,
      [requestId]
    );
    await pool.query(
      "UPDATE pre_analysis_requests SET reused_from_pre_analysis_request_id=$2 WHERE pre_analysis_request_id=$1",
      [requestId, fixture.otherRequestId]
    );
    await assert.rejects(
      pool.query(
        "UPDATE pre_analysis_requests SET reused_from_pre_analysis_request_id=NULL WHERE pre_analysis_request_id=$1",
        [requestId]
      ),
      hasCode("23514")
    );
  });

  it("enforces deferred reciprocal request/run linkage and both uniqueness directions", async () => {
    const valid = await seedDiscoveryHierarchy(pool, "reciprocal-valid");
    const validClient = await pool.connect();
    try {
      await validClient.query("BEGIN");
      const runId = await insertLinkedRun(validClient, valid, valid.requestId, "valid");
      await validClient.query(
        "UPDATE pre_analysis_requests SET status='analysis_created',analysis_run_id=$2,completed_at=now() WHERE pre_analysis_request_id=$1",
        [valid.requestId, runId]
      );
      await validClient.query("COMMIT");
    } finally {
      validClient.release();
    }

    const mismatch = await seedDiscoveryHierarchy(pool, "reciprocal-mismatch");
    const mismatchClient = await pool.connect();
    try {
      await mismatchClient.query("BEGIN");
      const runId = await insertLinkedRun(mismatchClient, mismatch, mismatch.otherRequestId, "mismatch-a");
      await mismatchClient.query(
        "UPDATE pre_analysis_requests SET status='analysis_created',analysis_run_id=$2,completed_at=now() WHERE pre_analysis_request_id=$1",
        [mismatch.requestId, runId]
      );
      await assert.rejects(mismatchClient.query("COMMIT"), hasCode("23514"));
      await mismatchClient.query("ROLLBACK");
    } finally {
      mismatchClient.release();
    }

    const reverse = await seedDiscoveryHierarchy(pool, "reciprocal-reverse");
    const reverseClient = await pool.connect();
    try {
      await reverseClient.query("BEGIN");
      const runA = await insertLinkedRun(reverseClient, reverse, reverse.requestId, "reverse-a");
      const runB = await insertLinkedRun(reverseClient, reverse, reverse.otherRequestId, "reverse-b");
      await reverseClient.query(
        "UPDATE pre_analysis_requests SET status='analysis_created',analysis_run_id=$2,completed_at=now() WHERE pre_analysis_request_id=$1",
        [reverse.requestId, runB]
      );
      await reverseClient.query(
        "UPDATE pre_analysis_requests SET status='analysis_created',analysis_run_id=$2,completed_at=now() WHERE pre_analysis_request_id=$1",
        [reverse.otherRequestId, runA]
      );
      await assert.rejects(reverseClient.query("COMMIT"), hasCode("23514"));
      await reverseClient.query("ROLLBACK");
    } finally {
      reverseClient.release();
    }

    const duplicate = await seedDiscoveryHierarchy(pool, "reciprocal-duplicates");
    const duplicateClient = await pool.connect();
    try {
      await duplicateClient.query("BEGIN");
      await insertLinkedRun(duplicateClient, duplicate, duplicate.requestId, "duplicate-a");
      await assert.rejects(
        insertLinkedRun(duplicateClient, duplicate, duplicate.requestId, "duplicate-b"),
        hasCode("23505")
      );
      await duplicateClient.query("ROLLBACK");
    } finally {
      duplicateClient.release();
    }

    const duplicateRequest = await seedDiscoveryHierarchy(pool, "reciprocal-request-duplicate");
    const duplicateRequestClient = await pool.connect();
    try {
      await duplicateRequestClient.query("BEGIN");
      const runId = await insertLinkedRun(duplicateRequestClient, duplicateRequest, duplicateRequest.requestId, "request-duplicate");
      await duplicateRequestClient.query(
        "UPDATE pre_analysis_requests SET status='analysis_created',analysis_run_id=$2,completed_at=now() WHERE pre_analysis_request_id=$1",
        [duplicateRequest.requestId, runId]
      );
      await assert.rejects(
        duplicateRequestClient.query(
          "UPDATE pre_analysis_requests SET status='analysis_created',analysis_run_id=$2,completed_at=now() WHERE pre_analysis_request_id=$1",
          [duplicateRequest.otherRequestId, runId]
        ),
        hasCode("23505")
      );
      await duplicateRequestClient.query("ROLLBACK");
    } finally {
      duplicateRequestClient.release();
    }
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

type SchemaDatabase = pg.Pool | pg.PoolClient;

type DiscoveryChain = {
  domainId: string;
  pathId: string;
  domainCategoryId: string;
  categoryBrandId: string;
  brandProductId: string;
  productUseContextId: string;
};

type DiscoveryFixture = DiscoveryChain & {
  sessionId: string;
  requestId: string;
  otherRequestId: string;
  other: DiscoveryChain;
};

async function seedDiscoveryHierarchy(
  database: SchemaDatabase,
  prefix: string
): Promise<DiscoveryFixture> {
  const unique = `${prefix}-${randomBytes(5).toString("hex")}`;
  const session = await database.query<{ id: string }>(
    `INSERT INTO anonymous_sessions(token_hash,expires_at)
     VALUES($1,now()+interval '1 hour') RETURNING anonymous_session_id id`,
    [`session-${unique}`]
  );
  const main = await seedHierarchyChain(database, `${unique}-main`);
  const other = await seedHierarchyChain(database, `${unique}-other`);
  const requestId = await seedPreAnalysisRequest(database, session.rows[0]!.id, main, `${unique}-main`);
  const otherRequestId = await seedPreAnalysisRequest(database, session.rows[0]!.id, other, `${unique}-other`);
  return {
    ...main,
    sessionId: session.rows[0]!.id,
    requestId,
    otherRequestId,
    other
  };
}

async function seedHierarchyChain(
  database: SchemaDatabase,
  prefix: string
): Promise<DiscoveryChain> {
  const domain = await database.query<{ id: string }>(
    "INSERT INTO domains(normalized_domain) VALUES($1) RETURNING domain_id id",
    [`${prefix}.example`]
  );
  const category = await database.query<{ id: string }>(
    "INSERT INTO categories(category_name,normalized_name) VALUES($1,$2) RETURNING category_id id",
    [`Category ${prefix}`, `category ${prefix}`]
  );
  const brand = await database.query<{ id: string }>(
    "INSERT INTO brands(brand_name,normalized_name) VALUES($1,$2) RETURNING brand_id id",
    [`Brand ${prefix}`, `brand ${prefix}`]
  );
  const product = await database.query<{ id: string }>(
    "INSERT INTO products(product_name,normalized_name) VALUES($1,$2) RETURNING product_id id",
    [`Product ${prefix}`, `product ${prefix}`]
  );
  const context = await database.query<{ id: string }>(
    "INSERT INTO use_contexts(use_context_name,normalized_name) VALUES($1,$2) RETURNING use_context_id id",
    [`Context ${prefix}`, `context ${prefix}`]
  );
  const domainCategory = await database.query<{ id: string }>(
    "INSERT INTO domain_categories(domain_id,category_id) VALUES($1,$2) RETURNING domain_category_id id",
    [domain.rows[0]!.id, category.rows[0]!.id]
  );
  const categoryBrand = await database.query<{ id: string }>(
    "INSERT INTO category_brands(domain_category_id,brand_id) VALUES($1,$2) RETURNING category_brand_id id",
    [domainCategory.rows[0]!.id, brand.rows[0]!.id]
  );
  const brandProduct = await database.query<{ id: string }>(
    "INSERT INTO brand_products(category_brand_id,product_id) VALUES($1,$2) RETURNING brand_product_id id",
    [categoryBrand.rows[0]!.id, product.rows[0]!.id]
  );
  const productContext = await database.query<{ id: string }>(
    "INSERT INTO product_use_contexts(brand_product_id,use_context_id) VALUES($1,$2) RETURNING product_use_context_id id",
    [brandProduct.rows[0]!.id, context.rows[0]!.id]
  );
  const path = await database.query<{ id: string }>(
    "INSERT INTO entity_paths(domain_id,path_type) VALUES($1,'domain') RETURNING entity_path_id id",
    [domain.rows[0]!.id]
  );
  return {
    domainId: domain.rows[0]!.id,
    pathId: path.rows[0]!.id,
    domainCategoryId: domainCategory.rows[0]!.id,
    categoryBrandId: categoryBrand.rows[0]!.id,
    brandProductId: brandProduct.rows[0]!.id,
    productUseContextId: productContext.rows[0]!.id
  };
}

async function seedPreAnalysisRequest(
  database: SchemaDatabase,
  sessionId: string,
  chain: DiscoveryChain,
  suffix: string
) {
  const result = await database.query<{ id: string }>(
    `INSERT INTO pre_analysis_requests
      (idempotency_key,anonymous_session_id,domain_id,starting_entity_path_id,
       category_selection_mode,prompt_depth,source,request_payload,
       canonical_request_hash,discovery_compatibility_hash)
     VALUES($1,$2,$3,$4,'all','weak','manual','{}',$5,$6)
     RETURNING pre_analysis_request_id id`,
    [`request-${suffix}`, sessionId, chain.domainId, chain.pathId, "1".repeat(64), "2".repeat(64)]
  );
  return result.rows[0]!.id;
}

async function seedDiscoveryJob(
  database: SchemaDatabase,
  fixture: DiscoveryFixture,
  stage: "category" | "brand" | "product" | "use_context",
  suffix: string,
  options: {
    requestId?: string;
    domainId?: string;
    domainCategoryId?: string | null;
    categoryBrandId?: string | null;
    brandProductId?: string | null;
    rendered?: boolean;
    fallback?: boolean;
  } = {}
) {
  const parent = {
    domainCategoryId: stage === "category" ? null : fixture.domainCategoryId,
    categoryBrandId: stage === "product" || stage === "use_context" ? fixture.categoryBrandId : null,
    brandProductId: stage === "use_context" ? fixture.brandProductId : null
  };
  const rendered = options.rendered ?? false;
  const fallback = options.fallback ?? false;
  const result = await database.query<{ id: string }>(
    `INSERT INTO hierarchy_discovery_jobs
      (idempotency_key,pre_analysis_request_id,domain_id,stage,
       domain_category_id,category_brand_id,brand_product_id,branch_key,candidate_set_hash,
       status,primary_provider,primary_model,fallback_provider,fallback_model,
       model_profile_version,discovery_policy_version,prompt_version,response_contract_version,
       provider_instruction_profile,structured_output_mode,input_payload,rendered_prompt,
       candidate_count,started_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'mock','mock-fast',$11,$12,
       'mock-fast-profile-v1','hierarchy-discovery-policy-v1',$13,$14,
       'mock-json-schema-v1','json_schema','{"candidates":[]}',$15,0,$16)
     RETURNING hierarchy_discovery_job_id id`,
    [
      `job-${suffix}-${randomBytes(4).toString("hex")}`,
      options.requestId ?? fixture.requestId,
      options.domainId ?? fixture.domainId,
      stage,
      options.domainCategoryId === undefined ? parent.domainCategoryId : options.domainCategoryId,
      options.categoryBrandId === undefined ? parent.categoryBrandId : options.categoryBrandId,
      options.brandProductId === undefined ? parent.brandProductId : options.brandProductId,
      randomBytes(32).toString("hex"),
      randomBytes(32).toString("hex"),
      rendered ? "processing" : "queued",
      fallback ? "mock" : null,
      fallback ? "mock-standard" : null,
      `hierarchy-discovery-${stage}-v1`,
      `hierarchy-discovery-${stage}-response-v1`,
      rendered ? `rendered ${stage}` : null,
      rendered ? new Date() : null
    ]
  );
  return result.rows[0]!.id;
}

async function seedDiscoveryProviderJob(
  database: SchemaDatabase,
  discoveryJobId: string,
  attempt: 0 | 1,
  provider: "mock" | "openai",
  model: string,
  suffix: string
) {
  const result = await database.query<{ id: string }>(
    `INSERT INTO provider_jobs
      (idempotency_key,job_kind,discovery_job_id,discovery_attempt,provider,model,
       response_contract_version,provider_instruction_profile,model_profile_version,
       structured_output_mode,request_hash,request_payload)
     VALUES($1,'hierarchy_discovery',$2,$3,$4,$5,
       'hierarchy-discovery-category-response-v1','test-instruction','test-profile',
       'json_schema',$6,'{}') RETURNING provider_job_id id`,
    [`provider-${suffix}-${randomBytes(4).toString("hex")}`, discoveryJobId, attempt, provider, model, "3".repeat(64)]
  );
  return result.rows[0]!.id;
}

async function seedInvalidProviderResult(
  database: SchemaDatabase,
  providerJobId: string,
  provider: "mock" | "openai",
  suffix: string
) {
  const result = await database.query<{ id: string }>(
    `INSERT INTO provider_results
      (idempotency_key,provider_job_id,provider,status,response_contract_version,
       raw_response,raw_response_original_bytes,validation_errors,
       context_validation_status,latency_ms,received_at)
     VALUES($1,$2,$3,'invalid','hierarchy-discovery-category-response-v1',
       '{}',2,'[{"code":"INVALID"}]','invalid',0,now())
     RETURNING provider_result_id id`,
    [`result-${suffix}-${randomBytes(4).toString("hex")}`, providerJobId, provider]
  );
  return result.rows[0]!.id;
}

async function insertLineage(
  database: SchemaDatabase,
  discoveryJobId: string,
  column: "domain_category_id" | "category_brand_id" | "brand_product_id" | "product_use_context_id",
  edgeId: string,
  providerResultId: string | null
) {
  const result = await database.query<{ id: string }>(
    `INSERT INTO hierarchy_discovery_relationships
      (hierarchy_discovery_job_id,${column},provider_result_id,action,rank,confidence,reason)
     VALUES($1,$2,$3,'reused',1,0.9,'test')
     RETURNING hierarchy_discovery_relationship_id id`,
    [discoveryJobId, edgeId, providerResultId]
  );
  return result.rows[0]!.id;
}

async function insertLinkedRun(
  database: SchemaDatabase,
  _fixture: DiscoveryFixture,
  requestId: string,
  suffix: string
) {
  const result = await database.query<{ id: string }>(
    `INSERT INTO analysis_runs
      (idempotency_key,anonymous_session_id,user_id,workspace_id,starting_entity_path_id,
       category_selection_mode,prompt_depth,prompt_policy_version,source,request_payload,
       pre_analysis_request_id)
     SELECT $1,anonymous_session_id,user_id,workspace_id,starting_entity_path_id,
       category_selection_mode,prompt_depth,'geo-prompt-policy-v1',source,'{}',pre_analysis_request_id
     FROM pre_analysis_requests WHERE pre_analysis_request_id=$2
     RETURNING analysis_run_id id`,
    [`linked-run-${suffix}-${randomBytes(4).toString("hex")}`, requestId]
  );
  return result.rows[0]!.id;
}
