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
import {
  InvalidProviderModelSelectionError,
  sameProviderModelSet,
  resolveProviderModelSet
} from "../../providers/policies/provider-model.policy.js";
import {
  InvalidPromptDepthError,
  PROMPT_POLICY_VERSION,
  resolvePromptDepth
} from "../../prompts/policies/prompt-policy.registry.js";
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
  AnalysisRunRequestedCategoryRepository,
  InactiveRequestedCategoryError
} from "../repositories/analysis-run-requested-category.repository.js";
import type {
  AnalysisPreviewResponse,
  AnalysisRunStatusResponse,
  AnalysisReportResponse,
  CanonicalAnalysisRequest,
  CreateAnalysisResponse
} from "../types/analysis.types.js";
import { normalizeDomain } from "../../../utils/domain-normalizer.js";
import { applicablePromptTypes } from "../../prompts/policies/prompt-policy.registry.js";
import { TokenEstimatorService } from "../../budgets/services/token-estimator.service.js";

type AnalysisDatabase = DatabaseExecutor & TransactionPool;

export class AnalysisService {
  constructor(
    private readonly database: AnalysisDatabase,
    private readonly hierarchy: HierarchyService = new HierarchyService(),
    private readonly realProvidersEnabled = false
  ) {}

  async preview(
    request: CreateAnalysisRequest,
    owner: OwnershipContext
  ): Promise<AnalysisPreviewResponse> {
    const categorySelection = request.categorySelection ?? { mode: "all" };
    const normalizedDomain = normalizeDomain(request.domain);
    const promptDepth = resolveAnalysisPromptDepth(request, owner);
    const models = resolveModelPreferences(
      request,
      owner,
      this.realProvidersEnabled
    );
    const categories = new AnalysisRunRequestedCategoryRepository(
      this.database
    );
    let frozenCategories;
    try {
      frozenCategories = await categories.resolveActive(
        categorySelection
      );
    } catch (error) {
      if (error instanceof InactiveRequestedCategoryError) {
        throw new ApplicationError("VALIDATION_ERROR", error.message);
      }
      throw error;
    }
    if (frozenCategories.length === 0) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Category selection resolved to no active categories"
      );
    }
    const domainOnly =
      !request.categoryId &&
      !request.brandId &&
      !request.productId &&
      !request.useContextId;
    const reused = domainOnly
      ? await this.database.query<{ count: string }>(
          `
            SELECT count(*)::bigint AS count
            FROM domains AS domain
            JOIN domain_categories AS relationship
              ON relationship.domain_id = domain.domain_id
             AND relationship.is_active
            WHERE domain.normalized_domain = $1
              AND relationship.category_id = ANY($2::bigint[])
          `,
          [
            normalizedDomain,
            frozenCategories.map((category) => category.category_id)
          ]
        )
      : { rows: [{ count: "0" }] };
    const reusedCount = Number(reused.rows[0]?.count ?? 0);
    const classificationRequired =
      domainOnly && reusedCount < frozenCategories.length;
    const breadth = owner.actorType === "anonymous" ? 3 : 5;
    const estimatedSelectedPathCount = domainOnly
      ? Math.min(breadth, frozenCategories.length)
      : breadth;
    const targetLevel = request.useContextId
      ? "use_context"
      : request.productId
        ? "use_context"
        : request.brandId
          ? "product"
          : request.categoryId
            ? "brand"
            : "category";
    const promptTypes = applicablePromptTypes(targetLevel);
    const estimator = new TokenEstimatorService();
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostMicros = 0;
    for (const model of models) {
      for (const promptType of promptTypes) {
        const estimate = estimator.estimate({
          provider: model.provider,
          model: model.model,
          promptText: "x".repeat(1_200),
          promptType,
          promptDepth
        });
        estimatedInputTokens +=
          estimate.inputTokens * estimatedSelectedPathCount;
        estimatedOutputTokens +=
          estimate.outputTokens * estimatedSelectedPathCount;
        estimatedCostMicros +=
          estimate.costMicros * estimatedSelectedPathCount;
      }
    }
    return {
      normalizedDomain,
      categorySelectionMode: categorySelection.mode,
      resolvedCategoryCandidateCount: frozenCategories.length,
      reusedMatchedCategoryCount: reusedCount,
      classificationRequired,
      estimatedSelectedPathCount,
      applicablePromptCount:
        estimatedSelectedPathCount * promptTypes.length,
      resolvedModelCount: models.length,
      estimatedProviderJobCount:
        estimatedSelectedPathCount * promptTypes.length * models.length +
        (classificationRequired ? 1 : 0),
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostMicros: {
        minimum: Math.floor(estimatedCostMicros * 0.8),
        maximum: Math.ceil(estimatedCostMicros * 1.2)
      }
    };
  }

  async create(
    request: CreateAnalysisRequest,
    clientIdempotencyKey: string,
    owner: OwnershipContext
  ): Promise<CreateAnalysisResponse> {
    const categorySelection = request.categorySelection ?? { mode: "all" };
    const providerModels = resolveModelPreferences(
      request,
      owner,
      this.realProvidersEnabled
    );
    return inTransaction(this.database, async (client) => {
      const requestedCategories =
        new AnalysisRunRequestedCategoryRepository(client);
      let frozenCategories;
      try {
        frozenCategories = await requestedCategories.resolveActive(
          categorySelection
        );
      } catch (error) {
        if (error instanceof InactiveRequestedCategoryError) {
          throw new ApplicationError("VALIDATION_ERROR", error.message);
        }
        throw error;
      }
      if (frozenCategories.length === 0) {
        throw new ApplicationError(
          "VALIDATION_ERROR",
          "Category selection resolved to no active categories"
        );
      }
      const promptDepth = resolveAnalysisPromptDepth(request, owner);
      const resolved = await this.hierarchy.resolveStartingPath(client, {
        domain: request.domain,
        categoryId: request.categoryId ?? null,
        brandId: request.brandId ?? null,
        productId: request.productId ?? null,
        useContextId: request.useContextId ?? null
      });
      const canonicalRequest: CanonicalAnalysisRequest = {
        domain: resolved.normalizedDomain,
        categoryId: request.categoryId ?? null,
        brandId: request.brandId ?? null,
        productId: request.productId ?? null,
        useContextId: request.useContextId ?? null,
        categorySelection: {
          mode: categorySelection.mode,
          categoryIds: frozenCategories.map((category) => category.category_id)
        },
        promptDepth,
        promptPolicyVersion: PROMPT_POLICY_VERSION,
        providerModels: providerModels.map(({ provider, model }) => ({
          provider,
          model
        }))
      };
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
        promptDepth,
        promptPolicyVersion: PROMPT_POLICY_VERSION,
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

function resolveModelPreferences(
  request: CreateAnalysisRequest,
  owner: OwnershipContext,
  realProvidersEnabled: boolean
) {
  try {
    return resolveProviderModelSet({
      actorType: owner.actorType,
      providerModels: request.providerModels ?? null,
      promptDepth: resolveAnalysisPromptDepth(request, owner),
      realProvidersEnabled
    });
  } catch (error) {
    if (error instanceof InvalidProviderModelSelectionError) {
      throw new ApplicationError("VALIDATION_ERROR", error.message);
    }
    throw error;
  }
}

function resolveAnalysisPromptDepth(
  request: CreateAnalysisRequest,
  owner: OwnershipContext
) {
  try {
    return resolvePromptDepth(owner.actorType, request.promptDepth);
  } catch (error) {
    if (error instanceof InvalidPromptDepthError) {
      throw new ApplicationError("VALIDATION_ERROR", error.message);
    }
    throw error;
  }
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
