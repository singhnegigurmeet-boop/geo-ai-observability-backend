import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { ApplicationError } from "../../../common/errors/application-error.js";
import { HierarchyService } from "../../hierarchy/services/hierarchy.service.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import type { OwnershipContext } from "../../../common/ownership/ownership-context.types.js";
import { AnalysisRunProviderModelRepository } from "../../providers/repositories/analysis-run-provider-model.repository.js";
import { sameProviderModelSet } from "../../providers/policies/provider-model.policy.js";
import { ReportAggregationService } from "../../reports/services/report-aggregation.service.js";
import { ReportOutcomeService } from "../../reports/services/report-outcome.service.js";
import { ReportRepository } from "../../reports/repositories/report.repository.js";
import type {
  AnalysisRunRow,
  ProviderName
} from "../../../common/types/database.types.js";
import type { CreateAnalysisRequest } from "../schemas/analysis.schemas.js";
import { AnalysisRepository } from "../repositories/analysis.repository.js";
import {
  AnalysisRunRequestedCategoryRepository
} from "../repositories/analysis-run-requested-category.repository.js";
import type {
  AnalysisPreviewResponse,
  AnalysisRunStatusResponse,
  AnalysisReportResponse,
  CanonicalAnalysisRequest,
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
    private readonly classifier: {
      provider: ProviderName;
      model: string;
      realProvidersEnabled: boolean;
    } = {
      provider: "mock",
      model: "mock-fast",
      realProvidersEnabled: false
    }
  ) {}

  async preview(
    request: CreateAnalysisRequest,
    owner: OwnershipContext
  ): Promise<AnalysisPreviewResponse> {
    const plan = await new CanonicalAnalysisPlannerService(
      this.database,
      this.hierarchy,
      this.realProvidersEnabled,
      this.classifier
    ).plan(request, owner);
    return {
      normalizedDomain: plan.normalizedDomain,
      categorySelectionMode: plan.frozenCategorySelection.mode,
      frozenCategoryIds: plan.frozenCategorySelection.categoryIds,
      frozenRequestedCategoryCount: plan.frozenRequestedCategoryCount,
      reusedMatchedCategoryCount: plan.reusedCategories.length,
      unresolvedCandidateCount: plan.unresolvedCategoryIds.length,
      classificationRequired: plan.classificationRequired,
      estimatedSelectedPathCount: plan.estimatedEligibleCategories,
      applicablePromptCountEstimate: plan.applicablePromptCountEstimate,
      applicablePromptTypes: [...plan.applicablePromptsByPath],
      resolvedModelCount: plan.resolvedProviderModels.length,
      resolvedProviderModels: plan.resolvedProviderModels,
      normalProviderJobCountEstimate:
        plan.expectedExecutions.normalProviderJobCountEstimate,
      classificationProviderJobCount:
        plan.expectedExecutions.classificationProviderJobCount,
      totalProviderJobCountEstimate:
        plan.expectedExecutions.totalProviderJobCountEstimate,
      tokenEstimate: plan.tokenEstimate,
      costEstimate: plan.costEstimate,
      normalAnalysisEstimate: plan.normalAnalysisEstimate,
      classificationEstimate: plan.classificationEstimate,
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
      const plan = await new CanonicalAnalysisPlannerService(
        client,
        this.hierarchy,
        this.realProvidersEnabled,
        this.classifier
      ).plan(request, owner);
      const categorySelection = plan.frozenCategorySelection;
      const providerModels = plan.resolvedProviderModels;
      const requestedCategories =
        new AnalysisRunRequestedCategoryRepository(client);
      const resolved = await this.hierarchy.resolveStartingPath(client, {
        domain: request.domain,
        categoryId: request.categoryId ?? null,
        brandId: request.brandId ?? null,
        productId: request.productId ?? null,
        useContextId: request.useContextId ?? null
      });
      const canonicalRequest = plan.canonicalRequestPayload;
      const idempotencyKey = ownerScopedIdempotencyKey(
        owner,
        clientIdempotencyKey
      );
      const analyses = new AnalysisRepository(client);
      const runProviderModels =
        new AnalysisRunProviderModelRepository(client);

      const existing = await analyses.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return replayResponse(
          existing,
          canonicalRequest,
          await runProviderModels.listPairs(existing.analysis_run_id),
          await requestedCategories.listIds(existing.analysis_run_id)
        );
      }

      const ownership = ownershipColumns(owner);
      const created = await analyses.create({
        idempotencyKey,
        ...ownership,
        startingEntityPathId: resolved.path.entity_path_id,
        categorySelectionMode: categorySelection.mode,
        promptDepth: plan.promptDepth,
        promptPolicyVersion: plan.promptPolicyVersion,
        requestPayload: canonicalRequest
      });
      if (!created) {
        const raced = await analyses.findByIdempotencyKey(idempotencyKey);
        if (!raced) {
          throw new Error("Idempotent analysis run could not be loaded");
        }
        return replayResponse(
          raced,
          canonicalRequest,
          await runProviderModels.listPairs(raced.analysis_run_id),
          await requestedCategories.listIds(raced.analysis_run_id)
        );
      }
      await runProviderModels.createOrReuse(
        created.analysis_run_id,
        providerModels
      );
      await requestedCategories.createOrReuse(
        created.analysis_run_id,
        canonicalRequest.categorySelection.categoryIds
      );

      await new OutboxEventWriterRepository(client).create({
        eventKey: `analysis_run.created:${created.analysis_run_id}`,
        eventType: "analysis_run.created",
        eventVersion: 1,
        aggregateType: "analysis_run",
        aggregateId: created.analysis_run_id,
        headers: { queueName: "analysis_run_queue" },
        payload: {
          analysisRunId: created.analysis_run_id
        }
      });

      return createResponse(created, false);
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
          LEFT JOIN domain_category_classification_jobs AS classification
            ON classification.domain_category_classification_job_id =
               job.classification_job_id
          WHERE COALESCE(item.analysis_run_id, classification.analysis_run_id) = $1
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
          UPDATE provider_jobs AS job
          SET status = 'cancelled', completed_at = now(), updated_at = now()
          FROM domain_category_classification_jobs AS classification
          WHERE job.classification_job_id =
                classification.domain_category_classification_job_id
            AND classification.analysis_run_id = $1
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
          UPDATE domain_category_classification_jobs
          SET status = 'cancelled',
              completed_at = now(),
              error_code = NULL,
              error_message = NULL,
              updated_at = now()
          WHERE analysis_run_id = $1
            AND status IN ('queued', 'processing')
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

function ownershipColumns(owner: OwnershipContext) {
  return owner.actorType === "anonymous"
    ? {
        anonymousSessionId: owner.anonymousSessionId,
        userId: null,
        workspaceId: null
      }
    : {
        anonymousSessionId: owner.anonymousSessionId,
        userId: owner.userId,
        workspaceId: owner.workspaceId
      };
}

function replayResponse(
  existing: AnalysisRunRow,
  canonicalRequest: CanonicalAnalysisRequest,
  storedProviderModels: Array<{ provider: ProviderName; model: string }>,
  storedCategoryIds: string[]
) {
  if (
    !sameCanonicalRequest(
      existing.request_payload,
      canonicalRequest,
      storedProviderModels,
      storedCategoryIds
    )
  ) {
    throw new ApplicationError(
      "CONFLICT",
      "Idempotency-Key was already used with a different analysis request"
    );
  }
  return createResponse(existing, true);
}

function sameCanonicalRequest(
  stored: AnalysisRunRow["request_payload"],
  expected: CanonicalAnalysisRequest,
  storedProviderModels: Array<{ provider: ProviderName; model: string }>,
  storedCategoryIds: string[]
) {
  const storedCategorySelection =
    stored.categorySelection &&
    typeof stored.categorySelection === "object" &&
    !Array.isArray(stored.categorySelection)
      ? stored.categorySelection
      : null;
  return (
    stored.domain === expected.domain &&
    stored.categoryId === expected.categoryId &&
    stored.brandId === expected.brandId &&
    stored.productId === expected.productId &&
    stored.useContextId === expected.useContextId &&
    storedCategorySelection?.mode === expected.categorySelection.mode &&
    JSON.stringify(storedCategoryIds) ===
      JSON.stringify(expected.categorySelection.categoryIds) &&
    stored.promptDepth === expected.promptDepth &&
    stored.promptPolicyVersion === expected.promptPolicyVersion &&
    sameProviderModelSet(storedProviderModels, expected.providerModels)
  );
}

function createResponse(
  run: AnalysisRunRow,
  idempotentReplay: boolean
): CreateAnalysisResponse {
  return {
    analysisRunId: run.analysis_run_id,
    startingEntityPathId: run.starting_entity_path_id,
    status: "queued",
    idempotentReplay,
    createdAt: run.created_at.toISOString()
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
