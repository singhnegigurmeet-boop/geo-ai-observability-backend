import { isDeepStrictEqual } from "node:util";
import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  DomainCategoryClassificationJobRow,
  JsonObject
} from "../../../common/types/database.types.js";
import {
  classificationCandidateSetHash,
  classificationIdempotencyKey
} from "./classification-execution-identity.service.js";

export type AuthoritativeRequestedCategory = {
  categoryId: string;
  categoryName: string | null;
  isActive: boolean | null;
  ordinal: number;
};

export type AuthoritativeClassificationContext = {
  inputPayload: JsonObject;
  candidates: Array<{
    categoryId: string;
    categoryName: string;
  }>;
};

export async function loadAuthoritativeClassificationState(
  database: DatabaseExecutor,
  analysisRunId: string
) {
  const run = await database.query<{
    run_domain_id: string | null;
    normalized_domain: string | null;
    domain_active: boolean | null;
  }>(
    `SELECT path.domain_id AS run_domain_id,
            domain.normalized_domain,
            domain.is_active AS domain_active
     FROM analysis_runs AS run
     JOIN entity_paths AS path
       ON path.entity_path_id = run.starting_entity_path_id
     LEFT JOIN domains AS domain ON domain.domain_id = path.domain_id
     WHERE run.analysis_run_id = $1
     FOR KEY SHARE OF run`,
    [analysisRunId]
  );
  if (!run.rows[0]) {
    throw new ClassificationIntegrityError(
      "CLASSIFICATION_ANALYSIS_RUN_MISSING",
      "The owning analysis run does not exist"
    );
  }
  const requested = await database.query<{
    category_id: string;
    category_name: string | null;
    is_active: boolean | null;
    ordinal: number;
  }>(
    `SELECT requested.category_id,
            category.category_name,
            category.is_active,
            requested.ordinal
     FROM analysis_run_requested_categories AS requested
     LEFT JOIN categories AS category
       ON category.category_id = requested.category_id
     WHERE requested.analysis_run_id = $1
     ORDER BY requested.ordinal, requested.category_id`,
    [analysisRunId]
  );
  return {
    runDomainId: run.rows[0].run_domain_id,
    normalizedDomain: run.rows[0].normalized_domain,
    domainActive: run.rows[0].domain_active,
    requestedCategories: requested.rows.map(
      (category): AuthoritativeRequestedCategory => ({
        categoryId: category.category_id,
        categoryName: category.category_name,
        isActive: category.is_active,
        ordinal: category.ordinal
      })
    )
  };
}

export class ClassificationIntegrityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClassificationIntegrityError";
  }
}

export function authoritativeClassificationContext(input: {
  job: DomainCategoryClassificationJobRow;
  runDomainId: string | null;
  normalizedDomain: string | null;
  domainActive: boolean | null;
  requestedCategories: readonly AuthoritativeRequestedCategory[];
}): AuthoritativeClassificationContext {
  if (
    input.runDomainId === null ||
    input.normalizedDomain === null ||
    input.domainActive === null
  ) {
    throw integrity(
      "CLASSIFICATION_DOMAIN_MISSING",
      "The authoritative classification domain does not exist"
    );
  }
  if (
    input.job.domain_id !== input.runDomainId ||
    input.job.domain_id.trim().length === 0
  ) {
    throw integrity(
      "CLASSIFICATION_DOMAIN_MISMATCH",
      "The classification domain differs from the owning analysis run"
    );
  }
  if (!input.domainActive) {
    throw integrity(
      "CLASSIFICATION_DOMAIN_INACTIVE",
      "The authoritative classification domain is inactive"
    );
  }
  if (input.requestedCategories.length === 0) {
    throw integrity(
      "CLASSIFICATION_REQUESTED_CATEGORIES_MISSING",
      "The frozen requested category snapshot is empty"
    );
  }
  for (const category of input.requestedCategories) {
    if (category.categoryName === null || category.isActive === null) {
      throw integrity(
        "CLASSIFICATION_CATEGORY_MISSING",
        `Frozen requested category ${category.categoryId} does not exist`
      );
    }
    if (!category.isActive) {
      throw integrity(
        "CLASSIFICATION_CATEGORY_INACTIVE",
        `Frozen requested category ${category.categoryId} is inactive`
      );
    }
  }

  const frozenIds = frozenCandidateIds(input.job.input_payload);
  if (frozenIds.length !== input.job.candidate_count) {
    throw integrity(
      "CLASSIFICATION_CANDIDATE_COUNT_MISMATCH",
      "Frozen classification candidate count does not match the job"
    );
  }
  const frozenSet = new Set(frozenIds);
  if (frozenSet.size !== frozenIds.length) {
    throw integrity(
      "CLASSIFICATION_CANDIDATE_DUPLICATED",
      "Frozen classification candidates contain duplicate IDs"
    );
  }
  const candidates = input.requestedCategories
    .filter((category) => frozenSet.has(category.categoryId))
    .map((category) => ({
      categoryId: category.categoryId,
      categoryName: category.categoryName!
    }));
  if (candidates.length !== frozenIds.length) {
    throw integrity(
      "CLASSIFICATION_CANDIDATE_NOT_REQUESTED",
      "A frozen classification candidate is not in the requested snapshot"
    );
  }
  if (
    candidates.some(
      (candidate, index) => candidate.categoryId !== frozenIds[index]
    )
  ) {
    throw integrity(
      "CLASSIFICATION_CANDIDATE_ORDER_MISMATCH",
      "Frozen classification candidates differ from requested-category order"
    );
  }
  const candidateSetHash = classificationCandidateSetHash(frozenIds);
  if (candidateSetHash !== input.job.candidate_set_hash) {
    throw integrity(
      "CLASSIFICATION_CANDIDATE_HASH_MISMATCH",
      "Frozen classification candidate hash does not match relational authority"
    );
  }
  const inputPayload = {
    domain: {
      id: input.runDomainId,
      name: input.normalizedDomain
    },
    candidates
  } satisfies JsonObject;
  if (!isDeepStrictEqual(input.job.input_payload, inputPayload)) {
    throw integrity(
      "CLASSIFICATION_INPUT_SNAPSHOT_MISMATCH",
      "Frozen classification input differs from relational authority"
    );
  }
  const expectedKey = classificationIdempotencyKey({
    analysisRunId: input.job.analysis_run_id,
    domainId: input.job.domain_id,
    candidateSetHash: input.job.candidate_set_hash,
    classifierProvider: input.job.classifier_provider,
    classifierModel: input.job.classifier_model,
    modelProfileVersion: input.job.model_profile_version,
    promptVersion: input.job.prompt_version,
    responseContractVersion: input.job.response_contract_version,
    providerInstructionProfile: input.job.provider_instruction_profile,
    structuredOutputMode: input.job.structured_output_mode
  });
  if (input.job.idempotency_key !== expectedKey) {
    throw integrity(
      "CLASSIFICATION_EXECUTION_IDENTITY_MISMATCH",
      "Classification execution identity does not match its canonical key"
    );
  }
  return { inputPayload, candidates };
}

function frozenCandidateIds(payload: JsonObject) {
  if (!Array.isArray(payload.candidates)) {
    throw integrity(
      "CLASSIFICATION_INPUT_SNAPSHOT_INVALID",
      "Frozen classification candidates are invalid"
    );
  }
  return payload.candidates.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      typeof candidate.categoryId !== "string" ||
      !/^[1-9]\d*$/.test(candidate.categoryId)
    ) {
      throw integrity(
        "CLASSIFICATION_INPUT_SNAPSHOT_INVALID",
        "Frozen classification candidate identity is invalid"
      );
    }
    return candidate.categoryId;
  });
}

function integrity(code: string, message: string) {
  return new ClassificationIntegrityError(code, message);
}
