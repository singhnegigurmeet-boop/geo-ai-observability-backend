import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { ApplicationError } from "../errors/application-error.js";
import { HierarchyService } from "../hierarchy/hierarchy.service.js";
import { OutboxEventWriterRepository } from "../outbox/outbox-event-writer.repository.js";
import type { OwnershipContext } from "../ownership/ownership-context.types.js";
import {
  InvalidProviderModelSelectionError,
  resolveProviderModelSet
} from "../providers/provider-model.policy.js";
import { ReportAggregationService } from "../reports/report-aggregation.service.js";
import { ReportRepository } from "../reports/report.repository.js";
import { MULTI_PROVIDER_REPORT_VERSION } from "../scoring/score.types.js";
import type { AnalysisRunRow } from "../types/database.types.js";
import type { CreateAnalysisRequest } from "./analysis.schemas.js";
import { AnalysisRepository } from "./analysis.repository.js";
import type {
  AnalysisRunStatusResponse,
  AnalysisReportResponse,
  CanonicalAnalysisRequest,
  CreateAnalysisResponse
} from "./analysis.types.js";

type AnalysisDatabase = DatabaseExecutor & TransactionPool;

export class AnalysisService {
  constructor(
    private readonly database: AnalysisDatabase,
    private readonly hierarchy: HierarchyService = new HierarchyService(),
    private readonly realProvidersEnabled = false
  ) {}

  async create(
    request: CreateAnalysisRequest,
    clientIdempotencyKey: string,
    owner: OwnershipContext
  ): Promise<CreateAnalysisResponse> {
    const providerModels = resolveModelPreferences(
      request,
      owner,
      this.realProvidersEnabled
    );
    return inTransaction(this.database, async (client) => {
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
        requestedProvider:
          owner.actorType === "anonymous" ? null : providerModels[0]!.provider,
        requestedModel:
          owner.actorType === "anonymous" ? null : providerModels[0]!.model,
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

      const existing = await analyses.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return replayResponse(
          existing,
          canonicalRequest,
          await analyses.findProviderModels(existing.analysis_run_id)
        );
      }

      const ownership = ownershipColumns(owner);
      const created = await analyses.create({
        idempotencyKey,
        ...ownership,
        startingEntityPathId: resolved.path.entity_path_id,
        requestedProvider: canonicalRequest.requestedProvider,
        requestedModel: canonicalRequest.requestedModel,
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
          await analyses.findProviderModels(raced.analysis_run_id)
        );
      }
      await analyses.createProviderModels(
        created.analysis_run_id,
        canonicalRequest.providerModels
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
      errorMessage: record.error_message,
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
          JOIN prompt_jobs AS prompt ON prompt.prompt_job_id = job.prompt_job_id
          JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
          JOIN analysis_run_items AS item
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
            AND job.status IN ('pending', 'queued')
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
            AND prompt.status IN ('pending', 'queued', 'processing')
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
        await reports.createRevision({
          analysisRunId,
          reportVersion: MULTI_PROVIDER_REPORT_VERSION,
          status: "failed",
          reportData: {
            analysisRunId,
            reportType: "multi_provider_report",
            reportVersion: MULTI_PROVIDER_REPORT_VERSION,
            lifecycleState: "cancelled_empty",
            final: true,
            summary: "The analysis was cancelled before provider execution began.",
            counts: {
              expected: 0,
              nonterminal: 0,
              scored: 0,
              invalid: 0,
              failed: 0,
              pausedBudget: 0,
              cancelled: 0,
              completionPercentage: 100
            },
            providerResults: [],
            promptScores: [],
            breakdown: [],
            usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 }
          },
          renderedText:
            "The analysis was cancelled before provider execution began."
        });
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
  storedProviderModels: Array<{ provider: string; model: string }>
) {
  if (
    !sameCanonicalRequest(
      existing.request_payload,
      canonicalRequest,
      storedProviderModels
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
  storedProviderModels: Array<{ provider: string; model: string }>
) {
  return (
    stored.domain === expected.domain &&
    stored.categoryId === expected.categoryId &&
    stored.brandId === expected.brandId &&
    stored.productId === expected.productId &&
    stored.useContextId === expected.useContextId &&
    (stored.requestedProvider ?? null) === expected.requestedProvider &&
    (stored.requestedModel ?? null) === expected.requestedModel &&
    JSON.stringify(
      storedProviderModels.map(({ provider, model }) => ({ provider, model }))
    ) === JSON.stringify(expected.providerModels)
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
      requestedProvider: request.preferredProvider ?? null,
      requestedModel: request.preferredModel ?? null,
      requestedProviderModels: request.providerModels ?? null,
      realProvidersEnabled
    });
  } catch (error) {
    if (error instanceof InvalidProviderModelSelectionError) {
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
