import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createIntegrationPool, resetTestSchema, truncatePublicTables } from "../../support/integration-environment.js";
import { ProviderAdapterRegistry } from "../../../src/modules/providers/adapters/provider-adapter.registry.js";
import { ProviderExecutionError } from "../../../src/modules/providers/errors/provider-execution.error.js";
import { ProviderJobRepository } from "../../../src/modules/providers/repositories/provider-job.repository.js";
import { ProviderExecutionService } from "../../../src/modules/providers/services/provider-execution.service.js";
import type { ProviderAdapter, ProviderExecutionRequest, ProviderGeneratedOutput } from "../../../src/modules/providers/types/provider-adapter.types.js";

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
});

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
