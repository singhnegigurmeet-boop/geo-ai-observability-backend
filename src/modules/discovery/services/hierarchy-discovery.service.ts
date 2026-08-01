import { createHash } from "node:crypto";
import type { DatabaseExecutor, TransactionPool } from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import type { EntityPathRow, HierarchyDiscoveryStage, JsonObject, PreAnalysisRequestRow, ProviderName } from "../../../common/types/database.types.js";
import { EntityPathRepository } from "../../hierarchy/repositories/entity-path.repository.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { ProviderJobRepository } from "../../providers/repositories/provider-job.repository.js";
import {
  ANONYMOUS_HIERARCHY_BREADTH,
  AUTHENTICATED_HIERARCHY_BREADTH,
  HIERARCHY_DISCOVERY_CONTRACT_VERSIONS,
  HIERARCHY_DISCOVERY_POLICY_VERSION,
  HIERARCHY_DISCOVERY_PROMPT_VERSIONS
} from "../../providers/contracts/provider-response.contracts.js";
import { providerModelProfile } from "../../providers/registry/provider-model.registry.js";
import type { HierarchyDiscoveryPayload } from "../messages/hierarchy-discovery.messages.js";
import { HierarchyDiscoveryRepository } from "../repositories/hierarchy-discovery.repository.js";
import { PreAnalysisRequestRepository } from "../repositories/pre-analysis-request.repository.js";
import { AnalysisRunRequestedCategoryRepository } from "../../analysis/repositories/analysis-run-requested-category.repository.js";
import { AnalysisCreationService } from "./analysis-creation.service.js";
import { listImmediateChildren } from "./hierarchy-navigation.service.js";

type DiscoveryDatabase = DatabaseExecutor & TransactionPool;

export class HierarchyDiscoveryService {
  constructor(private readonly database: DiscoveryDatabase, private readonly realProvidersEnabled = false) {}

  async progress(payload: HierarchyDiscoveryPayload) {
    return inTransaction(this.database, async (client) => {
      const requests = new PreAnalysisRequestRepository(client);
      let request = await requests.findForUpdate(payload.preAnalysisRequestId);
      if (!request) throw new PermanentDiscoveryError("PRE_ANALYSIS_REQUEST_NOT_FOUND", "Pre-analysis request does not exist");
      if (["analysis_created","completed_without_analysis","failed","cancelled"].includes(request.status)) return { outcome: "noop" as const, analysisRunId: request.analysis_run_id };
      const path = await new EntityPathRepository(client).findActiveValidated(request.starting_entity_path_id);
      if (!path) throw new PermanentDiscoveryError("STARTING_HIERARCHY_INVALID", "Starting hierarchy is inactive or invalid");
      const categoryIds = await new AnalysisRunRequestedCategoryRepository(client).listRequestIds(request.pre_analysis_request_id);
      await requests.mark(request.pre_analysis_request_id, { status: "checking_hierarchy" });
      if (request.request_payload.operation !== "navigate") {
        await requests.mark(request.pre_analysis_request_id, {
          status: "planning",
          discoveryStatus: "not_required",
          coverage: { mode: "exact_selected_path", incompleteBranches: [] }
        });
        request = (await requests.findForUpdate(request.pre_analysis_request_id))!;
        const runId = await new AnalysisCreationService(client, this.realProvidersEnabled).create(request);
        return { outcome: "analysis_created" as const, analysisRunId: runId };
      }
      return this.progressNavigation(client, request, path, categoryIds);
    });
  }

  private async progressNavigation(
    client: DatabaseExecutor,
    request: PreAnalysisRequestRow,
    path: EntityPathRow,
    categoryIds: string[]
  ) {
      const requests = new PreAnalysisRequestRepository(client);
      const requestedStage = request.request_payload.requestedStage;
      const expectedStage = nextStage(path.path_type);
      if (requestedStage !== expectedStage) {
        throw new PermanentDiscoveryError("NAVIGATION_STAGE_INVALID", "Frozen navigation stage does not match the selected parent path");
      }
      const children = await listImmediateChildren(client, {
        normalizedDomain: request.request_payload.domain as string,
        domainId: path.domain_id,
        categoryId: path.category_id,
        brandId: path.brand_id,
        productId: path.product_id,
        pathType: path.path_type
      }, request.user_id ? "user" : "anonymous");
      if (children.length > 0) {
        await requests.mark(request.pre_analysis_request_id, {
          status: "completed_without_analysis",
          discoveryStatus: "completed",
          coverage: { mode: "authoritative_hierarchy", requestedStage, incompleteBranches: [] }
        });
        return { outcome: "navigation_completed" as const, analysisRunId: null };
      }
      const jobs = new HierarchyDiscoveryRepository(client);
      const existing = await jobs.listJobs(request.pre_analysis_request_id, expectedStage);
      if (existing.some((job) => job.status === "queued" || job.status === "processing")) {
        return { outcome: "discovering" as const, analysisRunId: null };
      }
      if (existing.some((job) => job.status === "paused_budget")) {
        await requests.mark(request.pre_analysis_request_id, {
          status: "paused_budget",
          discoveryStatus: "paused_budget",
          errorCode: "DISCOVERY_BUDGET_EXHAUSTED",
          errorMessage: "Configured LLM budget prevented hierarchy discovery."
        });
        return { outcome: "paused_budget" as const, analysisRunId: null };
      }
      if (existing.length === 0) {
        await requests.mark(request.pre_analysis_request_id, {
          status: "discovering",
          discoveryStatus: "executing"
        });
        const created = await this.createStageJobs(client, request, path, categoryIds, expectedStage, false);
        if (created > 0) return { outcome: "discovering" as const, analysisRunId: null };
      }
      const failed = existing.filter((job) => job.status === "invalid" || job.status === "failed");
      if (failed.length > 0) {
        await requests.mark(request.pre_analysis_request_id, {
          status: "failed",
          discoveryStatus: "failed",
          coverage: {
            status: "failed",
            requestedStage,
            incompleteBranches: failed.map((job) => ({
              stage: job.stage,
              branchKey: job.branch_key,
              safeFailureCode: job.error_code ?? "DISCOVERY_INCOMPLETE"
            }))
          },
          errorCode: failed[0]!.error_code ?? "DISCOVERY_INCOMPLETE",
          errorMessage: "The requested hierarchy level could not be resolved."
        });
        return { outcome: "failed" as const, analysisRunId: null };
      }
      await requests.mark(request.pre_analysis_request_id, {
        status: "completed_without_analysis",
        discoveryStatus: "completed_empty",
        coverage: { status: "completed_empty", requestedStage, incompleteBranches: [] }
      });
      return { outcome: "navigation_completed_empty" as const, analysisRunId: null };
  }

  private async createStageJobs(client: DatabaseExecutor, request: PreAnalysisRequestRow, path: EntityPathRow, categoryIds: string[], stage: HierarchyDiscoveryStage, independentExecutionRequired: boolean) {
    if (!request.user_id && (stage === "product" || stage === "use_context")) {
      throw new PermanentDiscoveryError(
        "ANONYMOUS_NAVIGATION_LIMIT",
        "Anonymous discovery may not render or enqueue product or use-context stages"
      );
    }
    const contexts = await stageContexts(client, request, path, categoryIds, stage, independentExecutionRequired);
    let created = 0;
    for (const context of contexts) {
      if (context.hasActiveChildren && !independentExecutionRequired) continue;
      const profileData = parseDiscoveryProfile(request.request_payload);
      const profile = providerModelProfile(profileData.provider, profileData.model);
      if (!profile || !profile.eligibleForDiscovery || (!this.realProvidersEnabled && profile.provider !== "mock")) throw new PermanentDiscoveryError("DISCOVERY_PROFILE_UNAVAILABLE", "Frozen discovery provider/model is unavailable");
      const job = await new HierarchyDiscoveryRepository(client).createJob({ requestId: request.pre_analysis_request_id, domainId: request.domain_id, stage, domainCategoryId: context.domainCategoryId, categoryBrandId: context.categoryBrandId, brandProductId: context.brandProductId, primary: profile, fallback: profileData.fallback, policyVersion: HIERARCHY_DISCOVERY_POLICY_VERSION, promptVersion: HIERARCHY_DISCOVERY_PROMPT_VERSIONS[stage], contractVersion: HIERARCHY_DISCOVERY_CONTRACT_VERSIONS[stage], inputPayload: context.inputPayload, candidateIds: context.candidates.map((item) => item.id) });
      if (job.status !== "queued") continue;
      const prompt = renderDiscoveryPrompt(stage, context.inputPayload, HIERARCHY_DISCOVERY_PROMPT_VERSIONS[stage], HIERARCHY_DISCOVERY_CONTRACT_VERSIONS[stage]);
      await new HierarchyDiscoveryRepository(client).render(job.hierarchy_discovery_job_id, prompt);
      const requestPayload = { discoveryJobId: job.hierarchy_discovery_job_id, discoveryStage: stage, promptVersion: job.prompt_version, responseContractVersion: job.response_contract_version, renderedPrompt: prompt, discoveryContext: context.inputPayload };
      const providerJob = await new ProviderJobRepository(client).createOrReuseDiscovery({ discoveryJobId: job.hierarchy_discovery_job_id, provider: profile.provider, model: profile.model, responseContractVersion: job.response_contract_version, providerInstructionProfile: profile.providerInstructionProfile, modelProfileVersion: profile.modelProfileVersion, structuredOutputMode: profile.preferredStructuredOutputMode, requestHash: createHash("sha256").update(JSON.stringify(requestPayload)).digest("hex"), requestPayload });
      await new OutboxEventWriterRepository(client).createOrReuse({ eventKey: `provider_job.created:${providerJob.provider_job_id}`, eventType: "provider_job.created", eventVersion: 1, aggregateType: "provider_job", aggregateId: providerJob.provider_job_id, headers: { queueName: profile.queueName }, payload: { providerJobId: providerJob.provider_job_id } });
      created += 1;
    }
    return created;
  }
}

function nextStage(pathType: EntityPathRow["path_type"]): HierarchyDiscoveryStage { return pathType === "domain" ? "category" : pathType === "category" ? "brand" : pathType === "brand" ? "product" : "use_context"; }

async function stageContexts(database: DatabaseExecutor, request: PreAnalysisRequestRow, path: EntityPathRow, categoryIds: string[], stage: HierarchyDiscoveryStage, independentExecutionRequired: boolean) {
  const maximumResults = request.user_id
    ? AUTHENTICATED_HIERARCHY_BREADTH
    : ANONYMOUS_HIERARCHY_BREADTH;
  if (stage === "category") {
    const candidates = await database.query<{ id:string; name:string }>(
      `SELECT c.category_id AS id,c.category_name AS name
       FROM categories c
       LEFT JOIN domain_categories dc
         ON dc.domain_id=$1 AND dc.category_id=c.category_id AND dc.is_active
         WHERE c.category_id=ANY($2::bigint[]) AND c.is_active
          AND ($3::boolean OR dc.domain_category_id IS NULL)
       ORDER BY c.normalized_name,c.category_id`,
      [path.domain_id, categoryIds, independentExecutionRequired]
    );
    return [{ domainCategoryId:null,categoryBrandId:null,brandProductId:null,hasActiveChildren:candidates.rows.length===0,candidates:candidates.rows,inputPayload:{ domain:{id:path.domain_id,name:request.request_payload.domain as string}, candidates:candidates.rows, maximumResults } as JsonObject }];
  }
  const categoryFilter = path.category_id ? [path.category_id] : categoryIds;
  if (stage === "brand") {
    const rows = await database.query<{domain_category_id:string;category_id:string;category_name:string;has_children:boolean}>(`SELECT dc.domain_category_id,dc.category_id,c.category_name,EXISTS(SELECT 1 FROM category_brands cb WHERE cb.domain_category_id=dc.domain_category_id AND cb.is_active) has_children FROM domain_categories dc JOIN categories c ON c.category_id=dc.category_id AND c.is_active WHERE dc.domain_id=$1 AND dc.category_id=ANY($2::bigint[]) AND dc.is_active ORDER BY COALESCE(dc.discovery_rank,dc.sort_order),dc.domain_category_id`,[path.domain_id,categoryFilter]);
    return rows.rows.map((row)=>({domainCategoryId:row.domain_category_id,categoryBrandId:null,brandProductId:null,hasActiveChildren:row.has_children,candidates:[],inputPayload:{domain:{id:path.domain_id,name:request.request_payload.domain as string},category:{id:row.category_id,name:row.category_name},maximumResults} as JsonObject}));
  }
  if (stage === "product") {
    const rows = await database.query<{domain_category_id:string;category_brand_id:string;category_id:string;category_name:string;brand_id:string;brand_name:string;has_children:boolean}>(`SELECT dc.domain_category_id,cb.category_brand_id,dc.category_id,c.category_name,cb.brand_id,b.brand_name,EXISTS(SELECT 1 FROM brand_products bp WHERE bp.category_brand_id=cb.category_brand_id AND bp.is_active) has_children FROM domain_categories dc JOIN categories c ON c.category_id=dc.category_id AND c.is_active JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active JOIN brands b ON b.brand_id=cb.brand_id AND b.is_active WHERE dc.domain_id=$1 AND dc.category_id=ANY($2::bigint[]) AND dc.is_active AND ($3::bigint IS NULL OR cb.brand_id=$3) ORDER BY cb.sort_order NULLS LAST,cb.category_brand_id`,[path.domain_id,categoryFilter,path.brand_id]);
    return rows.rows.map((row)=>({domainCategoryId:row.domain_category_id,categoryBrandId:row.category_brand_id,brandProductId:null,hasActiveChildren:row.has_children,candidates:[],inputPayload:{domain:{id:path.domain_id,name:request.request_payload.domain as string},category:{id:row.category_id,name:row.category_name},brand:{id:row.brand_id,name:row.brand_name},maximumResults} as JsonObject}));
  }
  const candidates = await database.query<{id:string;name:string}>("SELECT use_context_id AS id,use_context_name AS name FROM use_contexts WHERE is_active ORDER BY normalized_name,use_context_id LIMIT 50");
  const rows = await database.query<{domain_category_id:string;category_brand_id:string;brand_product_id:string;category_id:string;category_name:string;brand_id:string;brand_name:string;product_id:string;product_name:string;has_children:boolean}>(`SELECT dc.domain_category_id,cb.category_brand_id,bp.brand_product_id,dc.category_id,c.category_name,cb.brand_id,b.brand_name,bp.product_id,p.product_name,EXISTS(SELECT 1 FROM product_use_contexts puc WHERE puc.brand_product_id=bp.brand_product_id AND puc.is_active) has_children FROM domain_categories dc JOIN categories c ON c.category_id=dc.category_id AND c.is_active JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active JOIN brands b ON b.brand_id=cb.brand_id AND b.is_active JOIN brand_products bp ON bp.category_brand_id=cb.category_brand_id AND bp.is_active JOIN products p ON p.product_id=bp.product_id AND p.is_active WHERE dc.domain_id=$1 AND dc.category_id=ANY($2::bigint[]) AND dc.is_active AND ($3::bigint IS NULL OR cb.brand_id=$3) AND ($4::bigint IS NULL OR bp.product_id=$4) ORDER BY bp.sort_order NULLS LAST,bp.brand_product_id`,[path.domain_id,categoryFilter,path.brand_id,path.product_id]);
  return rows.rows.map((row)=>({domainCategoryId:row.domain_category_id,categoryBrandId:row.category_brand_id,brandProductId:row.brand_product_id,hasActiveChildren:row.has_children,candidates:candidates.rows,inputPayload:{domain:{id:path.domain_id,name:request.request_payload.domain as string},category:{id:row.category_id,name:row.category_name},brand:{id:row.brand_id,name:row.brand_name},product:{id:row.product_id,name:row.product_name},candidates:candidates.rows,maximumResults} as JsonObject}));
}

function parseDiscoveryProfile(payload: JsonObject) { const value=payload.discoveryProfile; if(!value||typeof value!=="object"||Array.isArray(value)) throw new PermanentDiscoveryError("DISCOVERY_PROFILE_INVALID","Frozen discovery profile is invalid"); const row=value as Record<string,unknown>; const fallback=row.fallback&&typeof row.fallback==="object"&&!Array.isArray(row.fallback)?row.fallback as Record<string,unknown>:null; return {provider:row.provider as ProviderName,model:row.model as string,fallback:fallback?{provider:fallback.provider as ProviderName,model:fallback.model as string}:null}; }
export function renderDiscoveryPrompt(stage: HierarchyDiscoveryStage, context: JsonObject, promptVersion: string, contractVersion: string) {
  if (
    promptVersion !== HIERARCHY_DISCOVERY_PROMPT_VERSIONS[stage] ||
    contractVersion !== HIERARCHY_DISCOVERY_CONTRACT_VERSIONS[stage]
  ) {
    throw new PermanentDiscoveryError("DISCOVERY_VERSION_UNSUPPORTED", "Frozen discovery prompt identity is unsupported");
  }
  const maximumResults = context.maximumResults;
  if (!Number.isInteger(maximumResults) || (maximumResults as number) < 1 || (maximumResults as number) > AUTHENTICATED_HIERARCHY_BREADTH) {
    throw new PermanentDiscoveryError("DISCOVERY_CONTEXT_INVALID", "Frozen discovery breadth is invalid");
  }
  const instructions = {
    category: "Select only immediate categories for the exact domain, using only category_id values from candidates. Do not return brands, products, or use contexts.",
    brand: "Return only immediate brand names for the exact selected domain and category. Do not return products or use contexts.",
    product: "Return only immediate product names for the exact selected domain, category, and brand. Do not return use contexts.",
    use_context: "Select only immediate use contexts for the exact selected domain, category, brand, and product, using only use_context_id values from candidates."
  } as const;
  return [
    `Hierarchy discovery stage: ${stage}.`,
    `Prompt version: ${promptVersion}.`,
    `Response contract: ${contractVersion}.`,
    `Task: ${instructions[stage]}`,
    `Return at most ${maximumResults} results, ranked contiguously from 1.`,
    "Return strict JSON only. Backend candidate IDs and hierarchy context are authoritative; do not invent controlled IDs or broaden the branch.",
    `Authoritative context: ${JSON.stringify(context)}`
  ].join("\n");
}
export class PermanentDiscoveryError extends Error { readonly permanent=true; constructor(readonly code:string,message:string){super(message);this.name="PermanentDiscoveryError";} }
