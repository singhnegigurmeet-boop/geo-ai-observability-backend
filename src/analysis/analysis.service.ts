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
  selectProviderModel
} from "../providers/provider-model.policy.js";
import type { AnalysisRunRow } from "../types/database.types.js";
import type { CreateAnalysisRequest } from "./analysis.schemas.js";
import { AnalysisRepository } from "./analysis.repository.js";
import type {
  AnalysisRunStatusResponse,
  CanonicalAnalysisRequest,
  CreateAnalysisResponse
} from "./analysis.types.js";

type AnalysisDatabase = DatabaseExecutor & TransactionPool;

export class AnalysisService {
  constructor(
    private readonly database: AnalysisDatabase,
    private readonly hierarchy: HierarchyService = new HierarchyService()
  ) {}

  async create(
    request: CreateAnalysisRequest,
    clientIdempotencyKey: string,
    owner: OwnershipContext
  ): Promise<CreateAnalysisResponse> {
    const modelPreference = resolveModelPreference(request, owner);
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
        ...modelPreference
      };
      const idempotencyKey = ownerScopedIdempotencyKey(
        owner,
        clientIdempotencyKey
      );
      const analyses = new AnalysisRepository(client);

      const existing = await analyses.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return replayResponse(existing, canonicalRequest);
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
        return replayResponse(raced, canonicalRequest);
      }

      await new OutboxEventWriterRepository(client).create({
        eventKey: `analysis_run.created:${created.analysis_run_id}`,
        eventType: "analysis_run.created",
        eventVersion: 1,
        aggregateType: "analysis_run",
        aggregateId: created.analysis_run_id,
        headers: { queueName: "analysis_run_queue" },
        payload: {
          analysisRunId: created.analysis_run_id,
          startingEntityPathId: created.starting_entity_path_id,
          actorType: owner.actorType,
          userId: created.user_id,
          workspaceId: created.workspace_id,
          anonymousSessionId: created.anonymous_session_id
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
  canonicalRequest: CanonicalAnalysisRequest
) {
  if (!sameCanonicalRequest(existing.request_payload, canonicalRequest)) {
    throw new ApplicationError(
      "CONFLICT",
      "Idempotency-Key was already used with a different analysis request"
    );
  }
  return createResponse(existing, true);
}

function sameCanonicalRequest(
  stored: AnalysisRunRow["request_payload"],
  expected: CanonicalAnalysisRequest
) {
  return (
    stored.domain === expected.domain &&
    stored.categoryId === expected.categoryId &&
    stored.brandId === expected.brandId &&
    stored.productId === expected.productId &&
    stored.useContextId === expected.useContextId &&
    (stored.requestedProvider ?? null) === expected.requestedProvider &&
    (stored.requestedModel ?? null) === expected.requestedModel
  );
}

function resolveModelPreference(
  request: CreateAnalysisRequest,
  owner: OwnershipContext
) {
  try {
    const selection = selectProviderModel({
      actorType: owner.actorType,
      requestedProvider: request.preferredProvider ?? null,
      requestedModel: request.preferredModel ?? null
    });
    return owner.actorType === "anonymous"
      ? {
          requestedProvider: null,
          requestedModel: null
        }
      : {
          requestedProvider: selection.provider,
          requestedModel: selection.model
        };
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
