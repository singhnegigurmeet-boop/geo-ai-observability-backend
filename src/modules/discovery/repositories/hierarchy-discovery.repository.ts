import { createHash } from "node:crypto";
import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type { HierarchyDiscoveryJobRow, HierarchyDiscoveryStage, JsonObject, ProviderName } from "../../../common/types/database.types.js";

export class HierarchyDiscoveryRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async listJobs(requestId: string, stage?: HierarchyDiscoveryStage) {
    const result = await this.database.query<HierarchyDiscoveryJobRow>(
      `SELECT * FROM hierarchy_discovery_jobs WHERE pre_analysis_request_id=$1 AND ($2::hierarchy_discovery_stage IS NULL OR stage=$2::hierarchy_discovery_stage) ORDER BY hierarchy_discovery_job_id`,
      [requestId, stage ?? null]
    );
    return result.rows;
  }

  async findJobForUpdate(jobId: string) {
    const result = await this.database.query<HierarchyDiscoveryJobRow>("SELECT * FROM hierarchy_discovery_jobs WHERE hierarchy_discovery_job_id=$1 FOR UPDATE", [jobId]);
    return result.rows[0] ?? null;
  }

  async createJob(input: { requestId: string; domainId: string; stage: HierarchyDiscoveryStage; domainCategoryId?: string | null; categoryBrandId?: string | null; brandProductId?: string | null; primary: { provider: ProviderName; model: string; modelProfileVersion: string; providerInstructionProfile: string; preferredStructuredOutputMode: string }; fallback?: { provider: ProviderName; model: string } | null; policyVersion: string; promptVersion: string; contractVersion: string; inputPayload: JsonObject; candidateIds: readonly string[] }) {
    const branchIdentity = { requestId: input.requestId, stage: input.stage, domainCategoryId: input.domainCategoryId ?? null, categoryBrandId: input.categoryBrandId ?? null, brandProductId: input.brandProductId ?? null };
    const branchKey = sha(branchIdentity);
    const candidateSetHash = sha([...input.candidateIds]);
    const key = `hierarchy_discovery:${input.requestId}:${branchKey}`;
    const result = await this.database.query<HierarchyDiscoveryJobRow>(
      `INSERT INTO hierarchy_discovery_jobs
       (idempotency_key,pre_analysis_request_id,domain_id,stage,domain_category_id,category_brand_id,brand_product_id,branch_key,candidate_set_hash,status,primary_provider,primary_model,fallback_provider,fallback_model,model_profile_version,discovery_policy_version,prompt_version,response_contract_version,provider_instruction_profile,structured_output_mode,input_payload,candidate_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (pre_analysis_request_id,branch_key) DO NOTHING RETURNING *`,
      [key,input.requestId,input.domainId,input.stage,input.domainCategoryId??null,input.categoryBrandId??null,input.brandProductId??null,branchKey,candidateSetHash,input.primary.provider,input.primary.model,input.fallback?.provider??null,input.fallback?.model??null,input.primary.modelProfileVersion,input.policyVersion,input.promptVersion,input.contractVersion,input.primary.providerInstructionProfile,input.primary.preferredStructuredOutputMode,input.inputPayload,input.candidateIds.length]
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await this.database.query<HierarchyDiscoveryJobRow>("SELECT * FROM hierarchy_discovery_jobs WHERE pre_analysis_request_id=$1 AND branch_key=$2", [input.requestId, branchKey]);
    if (!existing.rows[0] || existing.rows[0].idempotency_key !== key) throw new Error("Discovery branch identity conflict");
    return existing.rows[0];
  }

  async render(jobId: string, prompt: string) {
    const result = await this.database.query<HierarchyDiscoveryJobRow>(
      `UPDATE hierarchy_discovery_jobs SET status='processing',rendered_prompt=$2,started_at=COALESCE(started_at,now()),updated_at=now() WHERE hierarchy_discovery_job_id=$1 AND status='queued' RETURNING *`,
      [jobId,prompt]
    );
    return result.rows[0] ?? null;
  }

  async terminal(jobId: string, status: "completed"|"completed_empty"|"invalid"|"failed", errorCode: string|null = null, errorMessage: string|null = null) {
    await this.database.query(`UPDATE hierarchy_discovery_jobs SET status=$2,completed_at=now(),error_code=$3,error_message=$4,updated_at=now() WHERE hierarchy_discovery_job_id=$1 AND status IN ('processing','paused_budget')`, [jobId,status,errorCode,errorMessage]);
  }

  async recordRelationship(input: { jobId: string; edge: "domain_category"|"category_brand"|"brand_product"|"product_use_context"; edgeId: string; providerResultId: string|null; action: "created"|"reactivated"|"reused"; rank: number; confidence: number|null; reason: string|null }) {
    const columns = { domain_category: "domain_category_id", category_brand: "category_brand_id", brand_product: "brand_product_id", product_use_context: "product_use_context_id" } as const;
    await this.database.query(
      `INSERT INTO hierarchy_discovery_relationships (hierarchy_discovery_job_id,${columns[input.edge]},provider_result_id,action,rank,confidence,reason) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [input.jobId,input.edgeId,input.providerResultId,input.action,input.rank,input.confidence,input.reason]
    );
  }
}

function sha(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
