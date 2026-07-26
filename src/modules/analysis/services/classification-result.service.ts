import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import type {
  DomainCategoryClassificationJobRow,
  JsonObject,
  ProviderName,
  ProviderResultStatus
} from "../../../common/types/database.types.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import {
  domainCategoryClassificationResponseSchema,
  type DomainCategoryClassificationResponse
} from "../../providers/contracts/provider-response.contracts.js";
import type { ClassificationResultCreatedPayload } from "../messages/classification-result-worker.messages.js";
import {
  authoritativeClassificationContext,
  ClassificationIntegrityError,
  loadAuthoritativeClassificationState
} from "./classification-authority.service.js";
import {
  classificationRelationshipAction
} from "./classification-relationship-policy.service.js";
import { renderClassificationPrompt } from "./classification-planning.service.js";

type ClassificationResultDatabase = DatabaseExecutor & TransactionPool;

type ClassificationResultState = DomainCategoryClassificationJobRow & {
  provider_result_id: string;
  result_status: ProviderResultStatus;
  validated_response: JsonObject | null;
  result_provider: ProviderName;
  result_response_contract_version: string;
  provider_job_id: string;
  job_provider: ProviderName;
  job_model: string;
  job_status: string;
  job_response_contract_version: string;
  job_provider_instruction_profile: string;
  job_model_profile_version: string;
  job_structured_output_mode: string;
  job_request_hash: string | null;
  job_request_payload: JsonObject;
};

export type ClassificationRelationshipCounts = {
  returnedMatchCount: number;
  newlyCreatedCount: number;
  reactivatedCount: number;
  concurrentlyReusedCount: number;
  existingReusedCount: number;
  acceptedActiveCount: number;
};

type ExistingRelationship = {
  domain_category_id: string;
  category_id: string;
  is_active: boolean;
  source: "manual" | "import" | "llm_classification";
};

export class ClassificationResultService {
  constructor(private readonly database: ClassificationResultDatabase) {}

  async process(payload: ClassificationResultCreatedPayload) {
    return inTransaction(this.database, async (client) => {
      const state = await loadResultState(client, payload.providerResultId);
      if (!state) {
        throw new PermanentClassificationResultError(
          "CLASSIFICATION_RESULT_NOT_FOUND",
          "Classification provider result does not exist"
        );
      }
      if (state.status !== "processing") {
        return { outcome: "noop" as const };
      }
      if (
        state.result_status !== "valid" ||
        state.validated_response === null
      ) {
        return invalidateAndContinue(client, state);
      }
      const response = domainCategoryClassificationResponseSchema.safeParse(
        state.validated_response
      );
      if (!response.success) {
        return invalidateAndContinue(client, state);
      }

      let authority;
      try {
        const relational = await loadAuthoritativeClassificationState(
          client,
          state.analysis_run_id
        );
        authority = authoritativeClassificationContext({
          job: state,
          ...relational
        });
      } catch (error) {
        if (error instanceof ClassificationIntegrityError) {
          return invalidateAndContinue(client, state);
        }
        throw error;
      }
      if (!providerResultMatchesFrozenIdentity(state, authority.inputPayload)) {
        return invalidateAndContinue(client, state);
      }
      if (!matchesFrozenCandidates(response.data, authority.candidates)) {
        return invalidateAndContinue(client, state);
      }

      const counts = await persistAcceptedRelationships(
        client,
        state.domain_id,
        state.provider_result_id,
        response.data
      );
      if (
        response.data.matches.length > 0 &&
        counts.acceptedActiveCount !== response.data.matches.length
      ) {
        throw new PermanentClassificationResultError(
          "CLASSIFICATION_RELATIONSHIP_PERSISTENCE_FAILED",
          "Validated classification matches did not produce active relationships"
        );
      }
      await terminalize(
        client,
        state.domain_category_classification_job_id,
        counts.acceptedActiveCount === 0 ? "completed_empty" : "completed",
        null,
        null
      );
      await requeueRun(client, state);
      return {
        outcome:
          counts.acceptedActiveCount === 0
            ? ("completed_empty" as const)
            : ("completed" as const),
        relationshipCount: counts.acceptedActiveCount,
        counts
      };
    });
  }
}

async function loadResultState(
  database: DatabaseExecutor,
  providerResultId: string
) {
  const state = await database.query<ClassificationResultState>(
    `SELECT
       classification.*,
       result.provider_result_id,
       result.status AS result_status,
       result.validated_response,
       result.provider AS result_provider,
       result.response_contract_version AS result_response_contract_version,
       provider_job.provider_job_id,
       provider_job.provider AS job_provider,
       provider_job.model AS job_model,
       provider_job.status AS job_status,
       provider_job.response_contract_version
         AS job_response_contract_version,
       provider_job.provider_instruction_profile
         AS job_provider_instruction_profile,
       provider_job.model_profile_version AS job_model_profile_version,
       provider_job.structured_output_mode AS job_structured_output_mode,
       provider_job.request_hash AS job_request_hash,
       provider_job.request_payload AS job_request_payload
     FROM provider_results AS result
     JOIN provider_jobs AS provider_job
       ON provider_job.provider_job_id = result.provider_job_id
      AND provider_job.job_kind = 'domain_category_classification'
     JOIN domain_category_classification_jobs AS classification
       ON classification.domain_category_classification_job_id =
          provider_job.classification_job_id
     JOIN analysis_runs AS run
       ON run.analysis_run_id = classification.analysis_run_id
     WHERE result.provider_result_id = $1
     FOR UPDATE OF result, provider_job, classification, run`,
    [providerResultId]
  );
  return state.rows[0] ?? null;
}

function providerResultMatchesFrozenIdentity(
  state: ClassificationResultState,
  authoritativeInput: JsonObject
) {
  if (
    state.result_provider !== state.classifier_provider ||
    state.result_response_contract_version !==
      state.response_contract_version ||
    state.job_provider !== state.classifier_provider ||
    state.job_model !== state.classifier_model ||
    state.job_status !== "succeeded" ||
    state.job_response_contract_version !==
      state.response_contract_version ||
    state.job_provider_instruction_profile !==
      state.provider_instruction_profile ||
    state.job_model_profile_version !== state.model_profile_version ||
    state.job_structured_output_mode !== state.structured_output_mode ||
    state.rendered_prompt === null
  ) {
    return false;
  }
  const expectedRequest = {
    classificationJobId: state.domain_category_classification_job_id,
    promptType: "domain_category_classification",
    promptVersion: state.prompt_version,
    responseContractVersion: state.response_contract_version,
    renderedPrompt: renderClassificationPrompt({
      normalizedDomain:
        (authoritativeInput.domain as { name: string }).name,
      candidates: authoritativeInput.candidates as Array<{
        categoryId: string;
        categoryName: string;
      }>,
      promptVersion: state.prompt_version,
      responseContractVersion: state.response_contract_version
    }),
    classificationContext: authoritativeInput
  };
  const expectedHash = createHash("sha256")
    .update(JSON.stringify(expectedRequest))
    .digest("hex");
  return (
    isDeepStrictEqual(state.job_request_payload, expectedRequest) &&
    state.job_request_hash === expectedHash &&
    state.rendered_prompt === expectedRequest.renderedPrompt
  );
}

function matchesFrozenCandidates(
  response: DomainCategoryClassificationResponse,
  candidates: readonly { categoryId: string }[]
) {
  if (response.matches.length > candidates.length) return false;
  const candidateIds = new Set(
    candidates.map((candidate) => candidate.categoryId)
  );
  return response.matches.every((match) =>
    candidateIds.has(match.category_id)
  );
}

async function persistAcceptedRelationships(
  database: DatabaseExecutor,
  domainId: string,
  providerResultId: string,
  response: DomainCategoryClassificationResponse
): Promise<ClassificationRelationshipCounts> {
  const matches = [...response.matches].sort(
    (left, right) =>
      left.rank - right.rank ||
      left.category_id.localeCompare(right.category_id)
  );
  const categoryIds = matches.map((match) => match.category_id);
  const activeCategories = await database.query<{ category_id: string }>(
    `SELECT category_id
     FROM categories
     WHERE category_id = ANY($1::bigint[])
       AND is_active
     ORDER BY category_id
     FOR KEY SHARE`,
    [categoryIds]
  );
  if (activeCategories.rows.length !== categoryIds.length) {
    throw new PermanentClassificationResultError(
      "CLASSIFICATION_CATEGORY_INACTIVE",
      "A validated classification category is missing or inactive"
    );
  }
  const initial = await database.query<ExistingRelationship>(
    `SELECT domain_category_id, category_id, is_active, source
     FROM domain_categories
     WHERE domain_id = $1
       AND category_id = ANY($2::bigint[])
     ORDER BY category_id
     FOR UPDATE`,
    [domainId, categoryIds]
  );
  const initiallyExisting = new Map(
    initial.rows.map((relationship) => [
      relationship.category_id,
      relationship
    ])
  );
  const counts: ClassificationRelationshipCounts = {
    returnedMatchCount: matches.length,
    newlyCreatedCount: 0,
    reactivatedCount: 0,
    concurrentlyReusedCount: 0,
    existingReusedCount: 0,
    acceptedActiveCount: 0
  };

  for (const match of matches) {
    const existing = initiallyExisting.get(match.category_id) ?? null;
    const action = classificationRelationshipAction(
      existing
        ? { isActive: existing.is_active, source: existing.source }
        : null
    );
    if (action === "reuse") {
      counts.existingReusedCount += 1;
      continue;
    }
    if (action === "reactivate") {
      await reactivateRelationship(
        database,
        existing!.domain_category_id,
        providerResultId,
        match.rank,
        match.confidence
      );
      counts.reactivatedCount += 1;
      continue;
    }
    const inserted = await database.query<{ domain_category_id: string }>(
      `INSERT INTO domain_categories (
         domain_id, category_id, is_active, source,
         classification_provider_result_id, classification_rank,
         classification_confidence, classified_at
       )
       VALUES ($1, $2, true, 'llm_classification', $3, $4, $5, now())
       ON CONFLICT (domain_id, category_id) DO NOTHING
       RETURNING domain_category_id`,
      [
        domainId,
        match.category_id,
        providerResultId,
        match.rank,
        match.confidence
      ]
    );
    if (inserted.rows[0]) {
      counts.newlyCreatedCount += 1;
      continue;
    }
    const raced = await database.query<ExistingRelationship>(
      `SELECT domain_category_id, category_id, is_active, source
       FROM domain_categories
       WHERE domain_id = $1 AND category_id = $2
       FOR UPDATE`,
      [domainId, match.category_id]
    );
    const relationship = raced.rows[0];
    if (!relationship) {
      throw new PermanentClassificationResultError(
        "CLASSIFICATION_RELATIONSHIP_RACE_FAILED",
        "Concurrent classification relationship could not be loaded"
      );
    }
    if (relationship.is_active) {
      counts.concurrentlyReusedCount += 1;
    } else {
      await reactivateRelationship(
        database,
        relationship.domain_category_id,
        providerResultId,
        match.rank,
        match.confidence
      );
      counts.reactivatedCount += 1;
    }
  }

  const accepted = await database.query<{ category_id: string }>(
    `SELECT relationship.category_id
     FROM domain_categories AS relationship
     JOIN categories AS category
       ON category.category_id = relationship.category_id
      AND category.is_active
     WHERE relationship.domain_id = $1
       AND relationship.category_id = ANY($2::bigint[])
       AND relationship.is_active
     ORDER BY relationship.category_id`,
    [domainId, categoryIds]
  );
  counts.acceptedActiveCount = accepted.rows.length;
  return counts;
}

async function reactivateRelationship(
  database: DatabaseExecutor,
  relationshipId: string,
  providerResultId: string,
  rank: number,
  confidence: number
) {
  const updated = await database.query<{ domain_category_id: string }>(
    `UPDATE domain_categories
     SET is_active = true,
         source = 'llm_classification',
         classification_provider_result_id = $2,
         classification_rank = $3,
         classification_confidence = $4,
         classified_at = now(),
         updated_at = now()
     WHERE domain_category_id = $1
       AND NOT is_active
     RETURNING domain_category_id`,
    [relationshipId, providerResultId, rank, confidence]
  );
  if (!updated.rows[0]) {
    throw new PermanentClassificationResultError(
      "CLASSIFICATION_RELATIONSHIP_REACTIVATION_FAILED",
      "Inactive classification relationship could not be reactivated"
    );
  }
}

async function invalidateAndContinue(
  database: DatabaseExecutor,
  state: ClassificationResultState
) {
  await terminalize(
    database,
    state.domain_category_classification_job_id,
    "invalid",
    "INVALID_CLASSIFICATION_EVIDENCE",
    "Classifier output failed authoritative validation"
  );
  await requeueRun(database, state);
  return {
    outcome: "invalid" as const,
    relationshipCount: 0,
    counts: emptyCounts()
  };
}

function emptyCounts(): ClassificationRelationshipCounts {
  return {
    returnedMatchCount: 0,
    newlyCreatedCount: 0,
    reactivatedCount: 0,
    concurrentlyReusedCount: 0,
    existingReusedCount: 0,
    acceptedActiveCount: 0
  };
}

async function terminalize(
  database: DatabaseExecutor,
  classificationJobId: string,
  status: "completed" | "completed_empty" | "invalid",
  errorCode: string | null,
  errorMessage: string | null
) {
  await database.query(
    `UPDATE domain_category_classification_jobs
     SET status = $2,
         error_code = $3,
         error_message = $4,
         completed_at = now(),
         updated_at = now()
     WHERE domain_category_classification_job_id = $1
       AND status = 'processing'`,
    [classificationJobId, status, errorCode, errorMessage]
  );
}

async function requeueRun(
  database: DatabaseExecutor,
  state: Pick<
    ClassificationResultState,
    "analysis_run_id" | "domain_category_classification_job_id"
  >
) {
  await new OutboxEventWriterRepository(database).createOrReuse({
    eventKey:
      `analysis_run.classification_completed:${state.analysis_run_id}:${state.domain_category_classification_job_id}`,
    eventType: "analysis_run.created",
    eventVersion: 1,
    aggregateType: "analysis_run",
    aggregateId: state.analysis_run_id,
    headers: { queueName: "analysis_run_queue" },
    payload: { analysisRunId: state.analysis_run_id }
  });
}

export class PermanentClassificationResultError extends Error {
  readonly permanent = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PermanentClassificationResultError";
  }
}
