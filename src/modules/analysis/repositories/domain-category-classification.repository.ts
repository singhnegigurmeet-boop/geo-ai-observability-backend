import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  DomainCategoryClassificationJobRow,
  ProviderName
} from "../../../common/types/database.types.js";
import type { ProviderModelSelection } from "../../providers/policies/provider-model.policy.js";
import {
  DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION,
  DOMAIN_CATEGORY_CLASSIFICATION_PROMPT_VERSION
} from "../../providers/contracts/provider-response.contracts.js";
import {
  classificationCandidateSetHash,
  classificationIdempotencyKey
} from "../services/classification-execution-identity.service.js";

export type ClassificationCandidate = {
  categoryId: string;
  categoryName: string;
};

export class DomainCategoryClassificationRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async unresolvedCandidates(analysisRunId: string, domainId: string) {
    const result = await this.database.query<{
      category_id: string;
      category_name: string | null;
      category_active: boolean | null;
      active_relationship_id: string | null;
    }>(
      `
        SELECT requested.category_id,
               category.category_name,
               category.is_active AS category_active,
               relationship.domain_category_id AS active_relationship_id
        FROM analysis_run_requested_categories AS requested
        LEFT JOIN categories AS category
          ON category.category_id = requested.category_id
        LEFT JOIN domain_categories AS relationship
          ON relationship.domain_id = $2
         AND relationship.category_id = requested.category_id
         AND relationship.is_active
        WHERE requested.analysis_run_id = $1
        ORDER BY requested.ordinal, requested.category_id
      `,
      [analysisRunId, domainId]
    );
    for (const row of result.rows) {
      if (row.category_name === null || row.category_active === null) {
        throw new ClassificationCandidateConfigurationError(
          "CLASSIFICATION_CATEGORY_MISSING",
          `Frozen requested category ${row.category_id} does not exist`
        );
      }
      if (!row.category_active) {
        throw new ClassificationCandidateConfigurationError(
          "CLASSIFICATION_CATEGORY_INACTIVE",
          `Frozen requested category ${row.category_id} is inactive`
        );
      }
    }
    return result.rows
      .filter((row) => row.active_relationship_id === null)
      .map((row) => ({
        categoryId: row.category_id,
        categoryName: row.category_name!
      }));
  }

  async createOrReuse(input: {
    analysisRunId: string;
    domainId: string;
    normalizedDomain: string;
    candidates: ClassificationCandidate[];
    classifier: ProviderModelSelection;
  }) {
    const candidateSetHash = classificationCandidateSetHash(
      input.candidates.map((candidate) => candidate.categoryId)
    );
    const idempotencyKey = classificationIdempotencyKey({
      analysisRunId: input.analysisRunId,
      domainId: input.domainId,
      candidateSetHash,
      classifierProvider: input.classifier.provider,
      classifierModel: input.classifier.model,
      modelProfileVersion: input.classifier.modelProfileVersion,
      promptVersion: DOMAIN_CATEGORY_CLASSIFICATION_PROMPT_VERSION,
      responseContractVersion:
        DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION,
      providerInstructionProfile:
        input.classifier.providerInstructionProfile,
      structuredOutputMode:
        input.classifier.preferredStructuredOutputMode
    });
    const inputPayload = {
      domain: { id: input.domainId, name: input.normalizedDomain },
      candidates: input.candidates
    };
    const inserted =
      await this.database.query<DomainCategoryClassificationJobRow>(
        `
          INSERT INTO domain_category_classification_jobs (
            idempotency_key, analysis_run_id, domain_id, candidate_set_hash,
            status, classifier_provider, classifier_model,
            model_profile_version, prompt_version,
            response_contract_version, provider_instruction_profile,
            structured_output_mode, input_payload, rendered_prompt,
            candidate_count
          )
          VALUES (
            $1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $10, $11,
            $12, NULL, $13
          )
          ON CONFLICT (analysis_run_id, candidate_set_hash) DO NOTHING
          RETURNING *
        `,
        [
          idempotencyKey,
          input.analysisRunId,
          input.domainId,
          candidateSetHash,
          input.classifier.provider,
          input.classifier.model,
          input.classifier.modelProfileVersion,
          DOMAIN_CATEGORY_CLASSIFICATION_PROMPT_VERSION,
          DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION,
          input.classifier.providerInstructionProfile,
          input.classifier.preferredStructuredOutputMode,
          inputPayload,
          input.candidates.length
        ]
      );
    if (inserted.rows[0]) {
      return { row: inserted.rows[0], created: true };
    }
    const existing =
      await this.database.query<DomainCategoryClassificationJobRow>(
        `
          SELECT *
          FROM domain_category_classification_jobs
          WHERE analysis_run_id = $1 AND candidate_set_hash = $2
        `,
        [input.analysisRunId, candidateSetHash]
      );
    if (!existing.rows[0]) {
      throw new Error("Classification job could not be loaded");
    }
    if (existing.rows[0].idempotency_key !== idempotencyKey) {
      throw new Error(
        "Existing classification decision has a different frozen execution identity"
      );
    }
    return { row: existing.rows[0], created: false };
  }
}

export function configuredClassifier(input: {
  provider: ProviderName;
  model: string;
}) {
  return input;
}

export class ClassificationCandidateConfigurationError extends Error {
  readonly permanent = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClassificationCandidateConfigurationError";
  }
}
