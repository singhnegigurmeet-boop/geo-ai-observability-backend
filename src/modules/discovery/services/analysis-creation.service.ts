import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type { JsonObject, PreAnalysisRequestRow, ProviderName } from "../../../common/types/database.types.js";
import type { OwnershipContext } from "../../../common/ownership/ownership-context.types.js";
import { AnalysisRepository } from "../../analysis/repositories/analysis.repository.js";
import { AnalysisRunRequestedCategoryRepository } from "../../analysis/repositories/analysis-run-requested-category.repository.js";
import { CanonicalAnalysisPlannerService } from "../../analysis/services/canonical-analysis-planner.service.js";
import type { CreateAnalysisRequest } from "../../analysis/schemas/analysis.schemas.js";
import { AnalysisRunProviderModelRepository } from "../../providers/repositories/analysis-run-provider-model.repository.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { PreAnalysisRequestRepository } from "../repositories/pre-analysis-request.repository.js";

export class AnalysisCreationService {
  constructor(private readonly database: DatabaseExecutor, private readonly realProvidersEnabled = false) {}

  async create(requestRow: PreAnalysisRequestRow) {
    if (requestRow.analysis_run_id) return requestRow.analysis_run_id;
    const request = parseFrozenRequest(requestRow.request_payload);
    const owner: OwnershipContext = requestRow.user_id && requestRow.workspace_id
      ? { actorType: "user", anonymousSessionId: requestRow.anonymous_session_id, userId: requestRow.user_id, workspaceId: requestRow.workspace_id, workspaceRole: "member" }
      : { actorType: "anonymous", anonymousSessionId: requestRow.anonymous_session_id!, userId: null, workspaceId: null };
    if (owner.actorType === "anonymous") request.providerModels = undefined;
    const categoryIds = await new AnalysisRunRequestedCategoryRepository(this.database).listRequestIds(requestRow.pre_analysis_request_id);
    await new PreAnalysisRequestRepository(this.database).mark(requestRow.pre_analysis_request_id, { status: "planning" });
    const plan = await new CanonicalAnalysisPlannerService(this.database, undefined, this.realProvidersEnabled).plan(request, owner, { frozenCategoryIds: categoryIds });
    const analyses = new AnalysisRepository(this.database);
    const run = await analyses.create({
      idempotencyKey: `pre_analysis:${requestRow.pre_analysis_request_id}`,
      anonymousSessionId: requestRow.anonymous_session_id,
      userId: requestRow.user_id,
      workspaceId: requestRow.workspace_id,
      startingEntityPathId: requestRow.starting_entity_path_id,
      categorySelectionMode: requestRow.category_selection_mode,
      promptDepth: plan.promptDepth,
      promptPolicyVersion: plan.promptPolicyVersion,
      source: requestRow.source,
      preAnalysisRequestId: requestRow.pre_analysis_request_id,
      requestPayload: { ...plan.canonicalRequestPayload, discovery: { status: requestRow.discovery_status ?? "completed", coverage: requestRow.discovery_coverage, reusedFromPreAnalysisRequestId: requestRow.reused_from_pre_analysis_request_id } }
    }) ?? await analyses.findByIdempotencyKey(`pre_analysis:${requestRow.pre_analysis_request_id}`);
    if (!run) throw new Error("Analysis run could not be created after hierarchy readiness");
    await new AnalysisRunProviderModelRepository(this.database).createOrReuse(run.analysis_run_id, plan.resolvedProviderModels);
    await new AnalysisRunRequestedCategoryRepository(this.database).createOrReuse(run.analysis_run_id, categoryIds);
    if (typeof requestRow.request_payload.schedulerJobId === "string") {
      await this.database.query(
        `UPDATE scheduler_jobs SET last_analysis_run_id=$2,updated_at=now()
         WHERE scheduler_job_id=$1 AND last_pre_analysis_request_id=$3`,
        [requestRow.request_payload.schedulerJobId, run.analysis_run_id, requestRow.pre_analysis_request_id]
      );
    }
    await new OutboxEventWriterRepository(this.database).createOrReuse({ eventKey: `analysis_run.created:${run.analysis_run_id}`, eventType: "analysis_run.created", eventVersion: 1, aggregateType: "analysis_run", aggregateId: run.analysis_run_id, headers: { queueName: "analysis_run_queue" }, payload: { analysisRunId: run.analysis_run_id } });
    await new PreAnalysisRequestRepository(this.database).mark(requestRow.pre_analysis_request_id, { status: "analysis_created", analysisRunId: run.analysis_run_id });
    return run.analysis_run_id;
  }
}

function parseFrozenRequest(payload: JsonObject): CreateAnalysisRequest {
  const providerModels = payload.providerModels;
  const categorySelection = payload.categorySelection;
  if (typeof payload.domain !== "string" || !Array.isArray(providerModels) || !categorySelection || typeof categorySelection !== "object" || Array.isArray(categorySelection)) throw new Error("Frozen pre-analysis request is invalid");
  const selection = categorySelection as Record<string, unknown>;
  return {
    domain: payload.domain,
    categoryId: typeof payload.categoryId === "string" ? payload.categoryId : undefined,
    brandId: typeof payload.brandId === "string" ? payload.brandId : undefined,
    productId: typeof payload.productId === "string" ? payload.productId : undefined,
    useContextId: typeof payload.useContextId === "string" ? payload.useContextId : undefined,
    categorySelection: selection.mode === "selected" ? { mode: "selected", categoryIds: selection.categoryIds as string[] } : { mode: "all" },
    promptDepth: payload.promptDepth as "weak" | "medium" | "high",
    providerModels: providerModels.map((entry) => { const value = entry as Record<string, unknown>; return { provider: value.provider as ProviderName, model: value.model as string }; })
  };
}
