import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { ApplicationError } from "../../../common/errors/application-error.js";
import { HierarchyService } from "../../hierarchy/services/hierarchy.service.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import type { OwnershipContext } from "../../../common/ownership/ownership-context.types.js";
import { InvalidProviderModelSelectionError, resolveDiscoveryModel, resolveProviderModelSet } from "../../providers/policies/provider-model.policy.js";
import { InvalidPromptDepthError, resolvePromptDepth } from "../../prompts/policies/prompt-policy.registry.js";
import { PreAnalysisRequestRepository } from "../../discovery/repositories/pre-analysis-request.repository.js";
import { HierarchyReadinessService } from "../../discovery/services/hierarchy-readiness.service.js";
import { HIERARCHY_DISCOVERY_CONTRACT_VERSIONS, HIERARCHY_DISCOVERY_POLICY_VERSION, HIERARCHY_DISCOVERY_PROMPT_VERSIONS } from "../../providers/contracts/provider-response.contracts.js";
import { hashCanonical } from "./canonical-analysis-planner.service.js";
import { ReportAggregationService } from "../../reports/services/report-aggregation.service.js";
import { ReportOutcomeService } from "../../reports/services/report-outcome.service.js";
import { ReportRepository } from "../../reports/repositories/report.repository.js";
import type { PreAnalysisRequestRow, ProviderName } from "../../../common/types/database.types.js";
import type { CreateAnalysisRequest } from "../schemas/analysis.schemas.js";
import { AnalysisRepository } from "../repositories/analysis.repository.js";
import {
  AnalysisRunRequestedCategoryRepository
} from "../repositories/analysis-run-requested-category.repository.js";
import type {
  AnalysisPreviewResponse,
  AnalysisRunStatusResponse,
  AnalysisReportResponse,
  CreateAnalysisResponse
} from "../types/analysis.types.js";
import {
  ANALYSIS_PLANNER_VERSION,
  CanonicalAnalysisPlannerService
} from "./canonical-analysis-planner.service.js";

type AnalysisDatabase = DatabaseExecutor & TransactionPool;

export class AnalysisService {
  constructor(
    private readonly database: AnalysisDatabase,
    private readonly hierarchy: HierarchyService = new HierarchyService(),
    private readonly realProvidersEnabled = false,
    private readonly discovery: {
      provider: ProviderName;
      model: string;
      fallbackProvider: ProviderName | null;
      fallbackModel: string | null;
      realProvidersEnabled: boolean;
    } = {
      provider: "mock",
      model: "mock-fast",
      fallbackProvider: null,
      fallbackModel: null,
      realProvidersEnabled: false
    }
  ) {}

  async preview(
    request: CreateAnalysisRequest,
    owner: OwnershipContext
  ): Promise<AnalysisPreviewResponse> {
    const selection = request.categorySelection ?? { mode: "all" as const };
    const categories = await new AnalysisRunRequestedCategoryRepository(this.database).resolveActive(selection);
    const hierarchy = await this.hierarchy.validateStartingPath(this.database, {
      domain: request.domain, categoryId: request.categoryId ?? null,
      brandId: request.brandId ?? null, productId: request.productId ?? null,
      useContextId: request.useContextId ?? null
    });
    const hierarchyReady = Boolean(hierarchy.path && await new HierarchyReadinessService(this.database).isReady(hierarchy.path, categories.map((row) => row.category_id)));
    if (!hierarchyReady) {
      return {
        normalizedDomain: hierarchy.normalizedDomain,
        categorySelectionMode: selection.mode,
        frozenCategoryIds: categories.map((row) => row.category_id),
        frozenRequestedCategoryCount: categories.length,
        hierarchyReady: false,
        discoveryRequired: true,
        estimatedSelectedPathCount: { minimum: 0, maximum: owner.actorType === "anonymous" ? 3 : 5 },
        applicablePromptCountEstimate: { minimum: 0, maximum: 25 },
        applicablePromptTypes: [], resolvedModelCount: 0, resolvedProviderModels: [],
        normalProviderJobCountEstimate: { minimum: 0, maximum: 0 },
        totalProviderJobCountEstimate: { minimum: 1, maximum: 86 },
        tokenEstimate: {}, costEstimate: {}, normalAnalysisEstimate: {}, byProviderModel: [], safetyLimits: {},
        canonicalPlannerVersion: ANALYSIS_PLANNER_VERSION,
        canonicalRequestHash: hashCanonical({ domain: hierarchy.normalizedDomain, categoryIds: categories.map((row) => row.category_id), discoveryRequired: true }),
        estimateNotice: "Hierarchy discovery is required; downstream analysis breadth is not exact until discovery completes."
      };
    }
    const plan = await new CanonicalAnalysisPlannerService(this.database, this.hierarchy, this.realProvidersEnabled).plan(request, owner);
    return {
      normalizedDomain: plan.normalizedDomain,
      categorySelectionMode: plan.frozenCategorySelection.mode,
      frozenCategoryIds: plan.frozenCategorySelection.categoryIds,
      frozenRequestedCategoryCount: plan.frozenRequestedCategoryCount,
      hierarchyReady: true,
      discoveryRequired: false,
      estimatedSelectedPathCount: plan.estimatedEligibleCategories,
      applicablePromptCountEstimate: plan.applicablePromptCountEstimate,
      applicablePromptTypes: [...plan.applicablePromptsByPath],
      resolvedModelCount: plan.resolvedProviderModels.length,
      resolvedProviderModels: plan.resolvedProviderModels,
      normalProviderJobCountEstimate:
        plan.expectedExecutions.normalProviderJobCountEstimate,
      totalProviderJobCountEstimate:
        plan.expectedExecutions.totalProviderJobCountEstimate,
      tokenEstimate: plan.tokenEstimate,
      costEstimate: plan.costEstimate,
      normalAnalysisEstimate: plan.normalAnalysisEstimate,
      byProviderModel: plan.byProviderModel,
      safetyLimits: plan.safetyLimits,
      canonicalPlannerVersion: ANALYSIS_PLANNER_VERSION,
      canonicalRequestHash: plan.canonicalRequestHash,
      estimateNotice:
        "Bounded planning estimate; actual provider usage and billing may vary."
    };
  }

  async create(
    request: CreateAnalysisRequest,
    clientIdempotencyKey: string,
    owner: OwnershipContext
  ): Promise<CreateAnalysisResponse> {
    return inTransaction(this.database, async (client) => {
      const categorySelection = request.categorySelection ?? { mode: "all" as const };
      const requestedCategories =
        new AnalysisRunRequestedCategoryRepository(client);
      const categories = await requestedCategories.resolveActive(categorySelection);
      const resolved = await this.hierarchy.resolveStartingPath(client, {
        domain: request.domain,
        categoryId: request.categoryId ?? null,
        brandId: request.brandId ?? null,
        productId: request.productId ?? null,
        useContextId: request.useContextId ?? null
      });
      let promptDepth;
      let providerModels;
      try {
        promptDepth = resolvePromptDepth(owner.actorType, request.promptDepth);
        providerModels = resolveProviderModelSet({ actorType: owner.actorType, providerModels: request.providerModels ?? null, promptDepth, realProvidersEnabled: this.realProvidersEnabled });
      } catch (error) {
        if (error instanceof InvalidPromptDepthError || error instanceof InvalidProviderModelSelectionError) {
          throw new ApplicationError("VALIDATION_ERROR", error.message);
        }
        throw error;
      }
      const discoveryModel = resolveDiscoveryModel({ provider: this.discovery.provider, model: this.discovery.model, realProvidersEnabled: this.discovery.realProvidersEnabled });
      const fallback = this.discovery.fallbackProvider && this.discovery.fallbackModel
        ? resolveDiscoveryModel({ provider: this.discovery.fallbackProvider, model: this.discovery.fallbackModel, realProvidersEnabled: this.discovery.realProvidersEnabled }) : null;
      const frozenCategoryIds = categories.map((row) => row.category_id);
      const canonicalRequest = {
        domain: resolved.normalizedDomain, categoryId: request.categoryId ?? null,
        brandId: request.brandId ?? null, productId: request.productId ?? null,
        useContextId: request.useContextId ?? null,
        categorySelection: { mode: categorySelection.mode, categoryIds: frozenCategoryIds },
        promptDepth, providerModels: providerModels.map(({ provider, model }) => ({ provider, model })),
        discoveryProfile: { ...discoveryModel, fallback: fallback ? { provider: fallback.provider, model: fallback.model, modelProfileVersion: fallback.modelProfileVersion } : null,
          policyVersion: HIERARCHY_DISCOVERY_POLICY_VERSION,
          promptVersions: HIERARCHY_DISCOVERY_PROMPT_VERSIONS,
          contractVersions: HIERARCHY_DISCOVERY_CONTRACT_VERSIONS }
      };
      const canonicalRequestHash = hashCanonical(canonicalRequest);
      const discoveryCompatibilityHash = hashCanonical({ domain: resolved.normalizedDomain, categoryIds: frozenCategoryIds, profile: canonicalRequest.discoveryProfile });
      const idempotencyKey = ownerScopedIdempotencyKey(
        owner,
        clientIdempotencyKey
      );
      const requests = new PreAnalysisRequestRepository(client);
      const existing = await requests.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.canonical_request_hash !== canonicalRequestHash) throw new ApplicationError("CONFLICT", "Idempotency-Key was already used with a different analysis request");
        return requestResponse(existing, true);
      }
      const created = await requests.create({ idempotencyKey, owner, domainId: resolved.domain.domain_id,
        startingEntityPathId: resolved.path.entity_path_id, categorySelectionMode: categorySelection.mode,
        promptDepth, source: "manual", requestPayload: canonicalRequest,
        canonicalRequestHash, discoveryCompatibilityHash });
      if (!created) {
        const raced = await requests.findByIdempotencyKey(idempotencyKey);
        if (!raced) throw new Error("Idempotent pre-analysis request could not be loaded");
        if (raced.canonical_request_hash !== canonicalRequestHash) throw new ApplicationError("CONFLICT", "Idempotency-Key was already used with a different analysis request");
        return requestResponse(raced, true);
      }
      await requestedCategories.createOrReuseForRequest(created.pre_analysis_request_id, frozenCategoryIds);

      await new OutboxEventWriterRepository(client).create({
        eventKey: `pre_analysis_request.accepted:${created.pre_analysis_request_id}`,
        eventType: "pre_analysis_request.accepted",
        eventVersion: 1,
        aggregateType: "pre_analysis_request",
        aggregateId: created.pre_analysis_request_id,
        headers: { queueName: "domain_hierarchy_discovery_queue" },
        payload: { preAnalysisRequestId: created.pre_analysis_request_id }
      });
      return requestResponse(created, false);
    });
  }

  async getStatus(
    analysisRunId: string,
    owner: OwnershipContext
  ): Promise<AnalysisRunStatusResponse> {
    const record = await new AnalysisRepository(
      this.database
    ).findOwnedStatus(analysisRunId, owner);
    if (!record) {
      throw new ApplicationError("NOT_FOUND", "Analysis run was not found");
    }

    return {
      analysisRunId: record.analysis_run_id,
      status: record.status,
      source: record.source,
      startingPath: {
        entityPathId: record.entity_path_id,
        pathType: record.path_type,
        domainId: record.domain_id,
        normalizedDomain: record.normalized_domain,
        categoryId: record.category_id,
        brandId: record.brand_id,
        productId: record.product_id,
        useContextId: record.use_context_id
      },
      errorCode: record.error_code,
      errorMessage: publicRunErrorMessage(record.error_code),
      startedAt: toIso(record.started_at),
      completedAt: toIso(record.completed_at),
      createdAt: record.created_at.toISOString(),
      updatedAt: record.updated_at.toISOString()
    };
  }

  async getRequestStatus(preAnalysisRequestId: string, owner: OwnershipContext) {
    const record = await new PreAnalysisRequestRepository(this.database).findOwned(preAnalysisRequestId, owner);
    if (!record) throw new ApplicationError("NOT_FOUND", "Pre-analysis request was not found");
    return {
      preAnalysisRequestId: record.pre_analysis_request_id,
      status: record.status,
      discoveryStatus: record.discovery_status,
      analysisRunId: record.analysis_run_id,
      errorCode: record.error_code,
      errorMessage: publicPreAnalysisErrorMessage(record.error_code),
      createdAt: record.created_at.toISOString(),
      updatedAt: record.updated_at.toISOString(),
      completedAt: toIso(record.completed_at)
    };
  }

  async cancel(analysisRunId: string, owner: OwnershipContext) {
    return inTransaction(this.database, async (client) => {
      const analyses = new AnalysisRepository(client);
      const run = await analyses.findOwnedRunForUpdate(analysisRunId, owner);
      if (!run) {
        throw new ApplicationError("NOT_FOUND", "Analysis run was not found");
      }
      if (run.status === "cancelled") {
        return { analysisRunId, status: "cancelled" as const, idempotent: true };
      }
      if (
        run.status === "completed" ||
        run.status === "partial_success" ||
        run.status === "failed"
      ) {
        throw new ApplicationError(
          "CONFLICT",
          "Terminal analysis run cannot be cancelled"
        );
      }
      const started = await client.query<{ provider_job_id: string }>(
        `
          SELECT job.provider_job_id
          FROM provider_jobs AS job
          LEFT JOIN prompt_jobs AS prompt
            ON prompt.prompt_job_id = job.prompt_job_id
          LEFT JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
          LEFT JOIN analysis_run_items AS item
            ON item.analysis_run_item_id = llm.analysis_run_item_id
          WHERE item.analysis_run_id = $1
            AND (
              job.started_at IS NOT NULL
              OR job.status IN ('processing', 'succeeded')
            )
          LIMIT 1
          FOR UPDATE OF job
        `,
        [analysisRunId]
      );
      if (started.rows[0]) {
        throw new ApplicationError(
          "CONFLICT",
          "Analysis cannot be cancelled after provider execution begins"
        );
      }
      await client.query(
        `
          UPDATE provider_jobs AS job
          SET status = 'cancelled', completed_at = now(), updated_at = now()
          FROM prompt_jobs AS prompt
          JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
          JOIN analysis_run_items AS item
            ON item.analysis_run_item_id = llm.analysis_run_item_id
          WHERE job.prompt_job_id = prompt.prompt_job_id
            AND item.analysis_run_id = $1
            AND job.status IN ('pending', 'queued', 'paused_budget')
            AND job.started_at IS NULL
        `,
        [analysisRunId]
      );
      await client.query(
        `
          UPDATE prompt_jobs AS prompt
          SET status = 'cancelled', completed_at = now(), updated_at = now()
          FROM llm_runs AS llm
          JOIN analysis_run_items AS item
            ON item.analysis_run_item_id = llm.analysis_run_item_id
          WHERE prompt.llm_run_id = llm.llm_run_id
            AND item.analysis_run_id = $1
            AND prompt.status IN ('pending', 'queued', 'processing', 'paused_budget')
        `,
        [analysisRunId]
      );
      await client.query(
        `
          UPDATE llm_runs AS llm
          SET status = 'cancelled', completed_at = now(), updated_at = now()
          FROM analysis_run_items AS item
          WHERE llm.analysis_run_item_id = item.analysis_run_item_id
            AND item.analysis_run_id = $1
            AND llm.status IN ('queued', 'processing')
        `,
        [analysisRunId]
      );
      await client.query(
        `
          UPDATE analysis_run_items
          SET status = 'cancelled', completed_at = now(), updated_at = now()
          WHERE analysis_run_id = $1
            AND status IN ('queued', 'processing')
        `,
        [analysisRunId]
      );
      await client.query(
        `
          UPDATE analysis_runs
          SET status = 'cancelled',
              completed_at = now(),
              error_code = NULL,
              error_message = NULL,
              updated_at = now()
          WHERE analysis_run_id = $1
        `,
        [analysisRunId]
      );
      const reports = new ReportRepository(client);
      const snapshot = await new ReportAggregationService(
        reports
      ).createIfReady(analysisRunId);
      if (snapshot.outcome === "not_ready") {
        await new ReportOutcomeService(reports).createCancelledEmpty(
          analysisRunId
        );
      }
      return { analysisRunId, status: "cancelled" as const, idempotent: false };
    });
  }

  async getReport(
    analysisRunId: string,
    owner: OwnershipContext
  ): Promise<AnalysisReportResponse> {
    const record = await new AnalysisRepository(
      this.database
    ).findOwnedReport(analysisRunId, owner);
    if (!record) {
      throw new ApplicationError(
        "NOT_FOUND",
        "Completed basic report was not found"
      );
    }
    return {
      analysisRunId: record.analysis_run_id,
      reportId: record.report_id,
      reportVersion: record.report_version,
      revision: record.revision,
      status: record.status,
      report: record.report_data,
      renderedText: record.rendered_text,
      generatedAt: record.generated_at.toISOString()
    };
  }
}

export function ownerScopedIdempotencyKey(
  owner: OwnershipContext,
  clientKey: string
) {
  return owner.actorType === "anonymous"
    ? `anonymous:${owner.anonymousSessionId}:${clientKey}`
    : `user:${owner.userId}:${owner.workspaceId}:${clientKey}`;
}

function requestResponse(
  request: PreAnalysisRequestRow,
  idempotentReplay: boolean
): CreateAnalysisResponse {
  return {
    preAnalysisRequestId: request.pre_analysis_request_id,
    analysisRunId: request.analysis_run_id,
    status: request.status,
    idempotentReplay,
    createdAt: request.created_at.toISOString()
  };
}

function toIso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function publicRunErrorMessage(errorCode: string | null) {
  if (errorCode === null) return null;
  if (errorCode === "BUDGET_LIMIT_REACHED") {
    return "Analysis paused because the configured budget was reached.";
  }
  if (errorCode === "NO_EXPANSION_CHILDREN") {
    return "No eligible taxonomy paths were available for analysis.";
  }
  return "Analysis could not complete. Use the error code when contacting support.";
}

function publicPreAnalysisErrorMessage(errorCode: string | null) {
  if (!errorCode) return null;
  if (errorCode === "DISCOVERY_BUDGET_EXHAUSTED") return "Hierarchy discovery paused because the configured LLM budget was reached.";
  if (errorCode === "NO_MATCHING_CATEGORY") return "No matching category was found in the allowed category set.";
  if (errorCode === "DISCOVERY_PROVIDER_UNAVAILABLE") return "Hierarchy discovery could not be completed by the configured provider.";
  return "Hierarchy discovery could not complete. Use the error code when contacting support.";
}
