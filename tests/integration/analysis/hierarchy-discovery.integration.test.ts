import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createIntegrationPool, resetTestSchema, truncatePublicTables } from "../../support/integration-environment.js";
import { ProviderAdapterRegistry } from "../../../src/modules/providers/adapters/provider-adapter.registry.js";
import { ProviderExecutionError } from "../../../src/modules/providers/errors/provider-execution.error.js";
import { ProviderJobRepository } from "../../../src/modules/providers/repositories/provider-job.repository.js";
import { ProviderExecutionService } from "../../../src/modules/providers/services/provider-execution.service.js";
import type { ProviderAdapter, ProviderExecutionRequest, ProviderGeneratedOutput } from "../../../src/modules/providers/types/provider-adapter.types.js";
import { PreAnalysisRequestRepository } from "../../../src/modules/discovery/repositories/pre-analysis-request.repository.js";
import { HierarchyDiscoveryService } from "../../../src/modules/discovery/services/hierarchy-discovery.service.js";
import { MockProviderService } from "../../../src/modules/providers/services/mock-provider.service.js";
import { ReportRepository } from "../../../src/modules/reports/repositories/report.repository.js";

const enabled = process.env.RUN_HIERARCHY_DISCOVERY_INTEGRATION_TESTS === "true";
describe("pre-analysis hierarchy discovery schema", { skip: !enabled }, () => {
  let pool: pg.Pool;
  before(async () => { pool = createIntegrationPool(); await resetTestSchema(pool); });
  beforeEach(async () => { await truncatePublicTables(pool); });
  after(async () => { await pool.end(); });

  it("installs the request, staged job, typed lineage, and dual-owner budget boundary", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name`,
      [["pre_analysis_requests", "hierarchy_discovery_jobs", "hierarchy_discovery_relationships"]]
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      "hierarchy_discovery_jobs", "hierarchy_discovery_relationships", "pre_analysis_requests"
    ]);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='token_usage' AND column_name IN ('analysis_run_id','provider_job_id') ORDER BY column_name`
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), ["provider_job_id"]);
  });

  it("uses one frozen fallback only for genuine provider credit exhaustion", async () => {
    const providerJobId = await seedProviderDiscovery(pool);
    const adapter = new ThrowingAdapter(new ProviderExecutionError("PROVIDER_CREDIT_EXHAUSTED", "credit exhausted", true));
    const outcome = await new ProviderExecutionService(pool, new ProviderAdapterRegistry([adapter]), 500).execute({ providerJobId });
    assert.equal(outcome.outcome, "fallback_enqueued");
    const jobs = await pool.query<{ discovery_attempt: number; provider: string; status: string }>(
      "SELECT discovery_attempt,provider,status FROM provider_jobs ORDER BY discovery_attempt"
    );
    assert.deepEqual(jobs.rows, [
      { discovery_attempt: 0, provider: "openai", status: "failed" },
      { discovery_attempt: 1, provider: "mock", status: "queued" }
    ]);
  });

  it("does not fallback for retryable provider failure or application budget denial", async () => {
    let providerJobId = await seedProviderDiscovery(pool);
    const retryable = new ThrowingAdapter(new ProviderExecutionError("PROVIDER_UNAVAILABLE", "temporary", false));
    await assert.rejects(new ProviderExecutionService(pool, new ProviderAdapterRegistry([retryable]), 500).execute({ providerJobId }), /temporary/);
    assert.equal((await pool.query("SELECT 1 FROM provider_jobs")).rowCount, 1);

    await truncatePublicTables(pool);
    providerJobId = await seedProviderDiscovery(pool);
    await pool.query("INSERT INTO budget_policies(budget_scope,provider,limit_mode,window_seconds,token_limit) VALUES('platform_default','openai','hard',3600,1)");
    const denied = new ThrowingAdapter(new Error("adapter must not run"));
    const outcome = await new ProviderExecutionService(pool, new ProviderAdapterRegistry([denied]), 500).execute({ providerJobId });
    assert.equal(outcome.outcome, "paused_budget");
    assert.equal(denied.calls, 0);
    assert.equal((await pool.query("SELECT 1 FROM provider_jobs")).rowCount, 1);
  });

  it("enforces the complete authenticated and anonymous reuse matrix", async () => {
    const cases: Array<{ name: string; prior: ScopeOwner; current: ScopeOwner; reusable: boolean }> = [
      { name: "same workspace and user", prior: "user-1-workspace-1", current: "user-1-workspace-1", reusable: true },
      { name: "same workspace and different user", prior: "user-1-workspace-1", current: "user-2-workspace-1", reusable: true },
      { name: "same user and different workspace", prior: "user-1-workspace-1", current: "user-1-workspace-2", reusable: false },
      { name: "different user and workspace", prior: "user-1-workspace-1", current: "user-2-workspace-2", reusable: false },
      { name: "same anonymous session", prior: "anonymous-1", current: "anonymous-1", reusable: true },
      { name: "different anonymous session", prior: "anonymous-1", current: "anonymous-2", reusable: false },
      { name: "authenticated after anonymous", prior: "anonymous-1", current: "user-1-workspace-1", reusable: false },
      { name: "anonymous after authenticated", prior: "user-1-workspace-1", current: "anonymous-1", reusable: false }
    ];

    for (const testCase of cases) {
      await truncatePublicTables(pool);
      const fixture = await seedReuseFixture(pool);
      const prior = await insertRequest(pool, fixture, testCase.prior, true);
      const current = await insertRequest(pool, fixture, testCase.current, false);
      const found = await new PreAnalysisRequestRepository(pool).findReusable(current);
      assert.equal(found?.pre_analysis_request_id ?? null, testCase.reusable ? prior.pre_analysis_request_id : null, testCase.name);
    }
  });

  it("executes discovery across forbidden boundaries while reusing global hierarchy rows", async () => {
    const boundaries: Array<{ name: string; prior: ScopeOwner; current: ScopeOwner }> = [
      { name: "workspace", prior: "user-1-workspace-1", current: "user-1-workspace-2" },
      { name: "different user and workspace", prior: "user-1-workspace-1", current: "user-2-workspace-2" },
      { name: "anonymous session", prior: "anonymous-1", current: "anonymous-2" },
      { name: "anonymous to authenticated", prior: "anonymous-1", current: "user-1-workspace-1" },
      { name: "authenticated to anonymous", prior: "user-1-workspace-1", current: "anonymous-1" }
    ];

    for (const boundary of boundaries) {
      await truncatePublicTables(pool);
      const fixture = await seedReuseFixture(pool);
      const prior = await insertRequest(pool, fixture, boundary.prior, true);
      await seedCompletedDiscoveryJob(pool, fixture, prior.pre_analysis_request_id);
      const current = await insertRequest(pool, fixture, boundary.current, false);

      const progress = await new HierarchyDiscoveryService(pool).progress({
        preAnalysisRequestId: current.pre_analysis_request_id
      });
      assert.equal(progress.outcome, "discovering", boundary.name);
      const reuseState = await pool.query<{ reused_from_pre_analysis_request_id: string | null }>(
        "SELECT reused_from_pre_analysis_request_id FROM pre_analysis_requests WHERE pre_analysis_request_id=$1",
        [current.pre_analysis_request_id]
      );
      assert.equal(reuseState.rows[0]?.reused_from_pre_analysis_request_id, null, boundary.name);
      const execution = await pool.query<{ hierarchy_discovery_job_id: string; provider_job_id: string }>(
        `SELECT discovery.hierarchy_discovery_job_id, provider.provider_job_id
         FROM hierarchy_discovery_jobs discovery
         JOIN provider_jobs provider ON provider.discovery_job_id=discovery.hierarchy_discovery_job_id
         WHERE discovery.pre_analysis_request_id=$1`,
        [current.pre_analysis_request_id]
      );
      assert.equal(execution.rowCount, 1, boundary.name);
      const outcome = await new MockProviderService(pool).execute({
        providerJobId: execution.rows[0]!.provider_job_id
      });
      assert.equal(outcome.outcome, "completed", boundary.name);
      assert.equal((await pool.query("SELECT 1 FROM token_usage WHERE provider_job_id=$1 AND usage_kind='actual'", [execution.rows[0]!.provider_job_id])).rowCount, 1, boundary.name);
      assert.equal((await pool.query("SELECT 1 FROM domain_categories WHERE domain_id=$1 AND category_id=$2", [fixture.domainId, fixture.categoryId])).rowCount, 1, boundary.name);
      const relationship = await pool.query<{ action: string }>(
        "SELECT action FROM hierarchy_discovery_relationships WHERE hierarchy_discovery_job_id=$1",
        [execution.rows[0]!.hierarchy_discovery_job_id]
      );
      assert.equal(relationship.rows[0]?.action, "reused", boundary.name);
    }
  });

  it("does not attribute historical discovery usage to a reused request", async () => {
    const fixture = await seedReuseFixture(pool);
    const prior = await insertRequest(pool, fixture, "user-1-workspace-1", true);
    const discoveryJobId = await seedCompletedDiscoveryJob(pool, fixture, prior.pre_analysis_request_id);
    const provider = await new ProviderJobRepository(pool).createOrReuseDiscovery({
      discoveryJobId, provider: "mock", model: "mock-fast",
      responseContractVersion: "hierarchy-discovery-category-response-v1",
      providerInstructionProfile: "mock-json-v1",
      modelProfileVersion: "mock-fast-profile-v1",
      structuredOutputMode: "json_schema",
      requestHash: "d".repeat(64), requestPayload: { discoveryJobId }
    });
    await pool.query(
      `INSERT INTO token_usage(idempotency_key,provider_job_id,usage_kind,input_tokens,output_tokens,cached_tokens,reasoning_tokens,cost_micros)
       VALUES($1,$2,'actual',101,23,0,0,456)`,
      [`historical-usage-${crypto.randomUUID()}`, provider.provider_job_id]
    );
    const current = await insertRequest(pool, fixture, "user-2-workspace-1", true);
    await pool.query(
      "UPDATE pre_analysis_requests SET reused_from_pre_analysis_request_id=$2 WHERE pre_analysis_request_id=$1",
      [current.pre_analysis_request_id, prior.pre_analysis_request_id]
    );

    const discovery = await new ReportRepository(pool).discoveryRecord(current.analysis_run_id!);
    assert.equal(discovery?.reused_from_pre_analysis_request_id, prior.pre_analysis_request_id);
    assert.equal(discovery?.input_tokens, null);
    assert.equal(discovery?.output_tokens, null);
    assert.equal(discovery?.cost_micros, null);
  });
});

type ScopeOwner =
  | "user-1-workspace-1" | "user-2-workspace-1"
  | "user-1-workspace-2" | "user-2-workspace-2"
  | "anonymous-1" | "anonymous-2";

async function seedReuseFixture(pool: pg.Pool) {
  const users = await pool.query<{ user_id: string }>(
    `INSERT INTO users(email) VALUES($1),($2) RETURNING user_id`,
    [`reuse-1-${crypto.randomUUID()}@example.com`, `reuse-2-${crypto.randomUUID()}@example.com`]
  );
  const workspaces = await pool.query<{ workspace_id: string }>(
    `INSERT INTO workspaces(workspace_name,created_by_user_id) VALUES($1,$3),($2,$4) RETURNING workspace_id`,
    [`Reuse 1 ${crypto.randomUUID()}`, `Reuse 2 ${crypto.randomUUID()}`, users.rows[0]!.user_id, users.rows[1]!.user_id]
  );
  for (const user of users.rows) for (const workspace of workspaces.rows) {
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [workspace.workspace_id, user.user_id]);
  }
  const sessions = await pool.query<{ anonymous_session_id: string }>(
    `INSERT INTO anonymous_sessions(token_hash,expires_at) VALUES($1,now()+interval '1 hour'),($2,now()+interval '1 hour') RETURNING anonymous_session_id`,
    [`reuse-session-${crypto.randomUUID()}`, `reuse-session-${crypto.randomUUID()}`]
  );
  const domain = await pool.query<{ domain_id: string }>("INSERT INTO domains(normalized_domain) VALUES($1) RETURNING domain_id", [`reuse-${crypto.randomUUID()}.example`]);
  const category = await pool.query<{ category_id: string }>("INSERT INTO categories(category_name,normalized_name) VALUES($1,$2) RETURNING category_id", [`Reuse ${crypto.randomUUID()}`, `reuse-${crypto.randomUUID()}`]);
  await pool.query("INSERT INTO domain_categories(domain_id,category_id) VALUES($1,$2)", [domain.rows[0]!.domain_id, category.rows[0]!.category_id]);
  const path = await pool.query<{ entity_path_id: string }>("INSERT INTO entity_paths(domain_id,path_type) VALUES($1,'domain') RETURNING entity_path_id", [domain.rows[0]!.domain_id]);
  return { userIds: users.rows.map((row) => row.user_id), workspaceIds: workspaces.rows.map((row) => row.workspace_id), sessionIds: sessions.rows.map((row) => row.anonymous_session_id), domainId: domain.rows[0]!.domain_id, categoryId: category.rows[0]!.category_id, pathId: path.rows[0]!.entity_path_id };
}

async function insertRequest(pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReuseFixture>>, owner: ScopeOwner, completed: boolean) {
  const ownership = owner.startsWith("anonymous")
    ? [fixture.sessionIds[Number(owner.endsWith("2"))], null, null]
    : [null, fixture.userIds[owner.startsWith("user-2") ? 1 : 0], fixture.workspaceIds[owner.endsWith("2") ? 1 : 0]];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const request = await client.query<{ pre_analysis_request_id: string }>(
      `INSERT INTO pre_analysis_requests(idempotency_key,anonymous_session_id,user_id,workspace_id,domain_id,starting_entity_path_id,category_selection_mode,prompt_depth,source,status,request_payload,canonical_request_hash,discovery_compatibility_hash,discovery_status,started_at)
       VALUES($1,$2,$3,$4,$5,$6,'selected','medium','manual','accepted',$7,$8,$8,$9,now()) RETURNING *`,
      [`reuse-request-${crypto.randomUUID()}`, ...ownership, fixture.domainId, fixture.pathId, { domain: "reuse.example", categorySelection: { mode: "selected", categoryIds: [fixture.categoryId] }, promptDepth: "medium", providerModels: [{ provider: "mock", model: "mock-standard" }], discoveryProfile: { provider: "mock", model: "mock-fast", fallback: null } }, "a".repeat(64), completed ? "completed" : null]
    );
    await client.query("INSERT INTO analysis_run_requested_categories(pre_analysis_request_id,category_id,ordinal) VALUES($1,$2,0)", [request.rows[0]!.pre_analysis_request_id, fixture.categoryId]);
    if (completed) {
      const run = await client.query<{ analysis_run_id: string }>(
        `INSERT INTO analysis_runs(idempotency_key,anonymous_session_id,user_id,workspace_id,starting_entity_path_id,category_selection_mode,prompt_depth,prompt_policy_version,source,status,request_payload,pre_analysis_request_id)
         VALUES($1,$2,$3,$4,$5,'selected','medium','geo-prompt-policy-v1','manual','queued','{}',$6) RETURNING analysis_run_id`,
        [`reuse-run-${crypto.randomUUID()}`, ...ownership, fixture.pathId, request.rows[0]!.pre_analysis_request_id]
      );
      await client.query("UPDATE pre_analysis_requests SET status='analysis_created',analysis_run_id=$2,completed_at=now() WHERE pre_analysis_request_id=$1", [request.rows[0]!.pre_analysis_request_id, run.rows[0]!.analysis_run_id]);
    }
    await client.query("COMMIT");
    return (await pool.query<import("../../../src/common/types/database.types.js").PreAnalysisRequestRow>("SELECT * FROM pre_analysis_requests WHERE pre_analysis_request_id=$1", [request.rows[0]!.pre_analysis_request_id])).rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function seedCompletedDiscoveryJob(pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReuseFixture>>, requestId: string) {
  const result = await pool.query<{ hierarchy_discovery_job_id: string }>(
    `INSERT INTO hierarchy_discovery_jobs(idempotency_key,pre_analysis_request_id,domain_id,stage,branch_key,candidate_set_hash,status,primary_provider,primary_model,model_profile_version,discovery_policy_version,prompt_version,response_contract_version,provider_instruction_profile,structured_output_mode,input_payload,rendered_prompt,candidate_count,started_at,completed_at)
     VALUES($1,$2,$3,'category',$4,$4,'completed','mock','mock-fast','mock-fast-profile-v1','hierarchy-discovery-policy-v1','hierarchy-discovery-category-v1','hierarchy-discovery-category-response-v1','mock-json-v1','json_schema','{}','prior discovery',1,now(),now()) RETURNING hierarchy_discovery_job_id`,
    [`reuse-prior-job-${crypto.randomUUID()}`, requestId, fixture.domainId, "b".repeat(64)]
  );
  return result.rows[0]!.hierarchy_discovery_job_id;
}

class ThrowingAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;
  calls = 0;
  constructor(private readonly error: Error) {}
  supportsModel(model: string) { return model === "gpt-4o-mini"; }
  async execute(_request: ProviderExecutionRequest): Promise<ProviderGeneratedOutput> { this.calls += 1; throw this.error; }
}

async function seedProviderDiscovery(pool: pg.Pool) {
  const session = await pool.query<{ id:string }>("INSERT INTO anonymous_sessions(token_hash,expires_at) VALUES($1,now()+interval '1 hour') RETURNING anonymous_session_id id",[`discovery-${crypto.randomUUID()}`]);
  const domain = await pool.query<{ id:string }>("INSERT INTO domains(normalized_domain) VALUES($1) RETURNING domain_id id",[`discovery-${crypto.randomUUID()}.example`]);
  const path = await pool.query<{ id:string }>("INSERT INTO entity_paths(domain_id,path_type) VALUES($1,'domain') RETURNING entity_path_id id",[domain.rows[0]!.id]);
  const request = await pool.query<{ id:string }>(`INSERT INTO pre_analysis_requests(idempotency_key,anonymous_session_id,domain_id,starting_entity_path_id,category_selection_mode,prompt_depth,source,status,request_payload,canonical_request_hash,discovery_compatibility_hash,discovery_status,started_at) VALUES($1,$2,$3,$4,'all','weak','manual','discovering','{}',$5,$5,'executing',now()) RETURNING pre_analysis_request_id id`,[`request-${crypto.randomUUID()}`,session.rows[0]!.id,domain.rows[0]!.id,path.rows[0]!.id,"0".repeat(64)]);
  const job = await pool.query<{ id:string }>(`INSERT INTO hierarchy_discovery_jobs(idempotency_key,pre_analysis_request_id,domain_id,stage,branch_key,candidate_set_hash,status,primary_provider,primary_model,fallback_provider,fallback_model,model_profile_version,discovery_policy_version,prompt_version,response_contract_version,provider_instruction_profile,structured_output_mode,input_payload,rendered_prompt,candidate_count,started_at) VALUES($1,$2,$3,'category',$4,$4,'processing','openai','gpt-4o-mini','mock','mock-fast','gpt-4o-mini-profile-v1','hierarchy-discovery-policy-v1','hierarchy-discovery-category-v1','hierarchy-discovery-category-response-v1','openai-json-schema-v1','json_schema','{"candidates":[]}','discover categories',0,now()) RETURNING hierarchy_discovery_job_id id`,[`job-${crypto.randomUUID()}`,request.rows[0]!.id,domain.rows[0]!.id,"1".repeat(64)]);
  const provider = await new ProviderJobRepository(pool).createOrReuseDiscovery({discoveryJobId:job.rows[0]!.id,provider:"openai",model:"gpt-4o-mini",responseContractVersion:"hierarchy-discovery-category-response-v1",providerInstructionProfile:"openai-json-schema-v1",modelProfileVersion:"gpt-4o-mini-profile-v1",structuredOutputMode:"json_schema",requestHash:"2".repeat(64),requestPayload:{discoveryJobId:job.rows[0]!.id}});
  return provider.provider_job_id;
}
