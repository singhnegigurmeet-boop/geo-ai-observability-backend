import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  JsonObject,
  ProviderJobRow,
  ProviderName
} from "../../../common/types/database.types.js";

export class ProviderJobRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async createOrReuse(input: {
    promptJobId: string;
    provider: ProviderName;
    model: string;
    responseContractVersion: string;
    providerInstructionProfile: string;
    modelProfileVersion: string;
    structuredOutputMode: string;
    requestHash: string;
    requestPayload: JsonObject;
  }) {
    const idempotencyKey =
      `provider_job:${input.promptJobId}:${input.provider}:${input.model}`;
    const inserted = await this.database.query<ProviderJobRow>(
      `
        INSERT INTO provider_jobs (
          idempotency_key,
          job_kind,
          prompt_job_id,
          provider,
          model,
          response_contract_version,
          provider_instruction_profile,
          model_profile_version,
          structured_output_mode,
          request_hash,
          status,
          request_payload
        )
        VALUES (
          $1, 'normal_prompt', $2, $3, $4, $5, $6, $7, $8, $9,
          'queued', $10
        )
        ON CONFLICT (prompt_job_id, provider, model)
          WHERE job_kind = 'normal_prompt'
        DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.promptJobId,
        input.provider,
        input.model,
        input.responseContractVersion,
        input.providerInstructionProfile,
        input.modelProfileVersion,
        input.structuredOutputMode,
        input.requestHash,
        input.requestPayload
      ]
    );
    if (inserted.rows[0]) {
      return inserted.rows[0];
    }

    const existing = await this.database.query<ProviderJobRow>(
      `
        SELECT *
        FROM provider_jobs
        WHERE prompt_job_id = $1
          AND provider = $2
          AND model = $3
          AND idempotency_key = $4
          AND response_contract_version = $5
          AND provider_instruction_profile = $6
          AND model_profile_version = $7
          AND structured_output_mode = $8
          AND request_hash = $9
          AND request_payload = $10::jsonb
      `,
      [
        input.promptJobId,
        input.provider,
        input.model,
        idempotencyKey,
        input.responseContractVersion,
        input.providerInstructionProfile,
        input.modelProfileVersion,
        input.structuredOutputMode,
        input.requestHash,
        input.requestPayload
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing provider job violates its stable identity");
    }
    return existing.rows[0];
  }

  async createOrReuseClassification(input: {
    classificationJobId: string;
    provider: ProviderName;
    model: string;
    responseContractVersion: string;
    providerInstructionProfile: string;
    modelProfileVersion: string;
    structuredOutputMode: string;
    requestHash: string;
    requestPayload: JsonObject;
  }) {
    const idempotencyKey =
      `provider_job:classification:${input.classificationJobId}`;
    const inserted = await this.database.query<ProviderJobRow>(
      `
        INSERT INTO provider_jobs (
          idempotency_key, job_kind, classification_job_id,
          provider, model, response_contract_version,
          provider_instruction_profile, model_profile_version,
          structured_output_mode, request_hash, status, request_payload
        )
        VALUES (
          $1, 'domain_category_classification', $2, $3, $4, $5, $6,
          $7, $8, $9, 'queued', $10
        )
        ON CONFLICT (classification_job_id)
          WHERE job_kind = 'domain_category_classification'
        DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.classificationJobId,
        input.provider,
        input.model,
        input.responseContractVersion,
        input.providerInstructionProfile,
        input.modelProfileVersion,
        input.structuredOutputMode,
        input.requestHash,
        input.requestPayload
      ]
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.database.query<ProviderJobRow>(
      `
        SELECT *
        FROM provider_jobs
        WHERE classification_job_id = $1
          AND job_kind = 'domain_category_classification'
          AND idempotency_key = $2
          AND provider = $3
          AND model = $4
          AND response_contract_version = $5
          AND provider_instruction_profile = $6
          AND model_profile_version = $7
          AND structured_output_mode = $8
          AND request_hash = $9
          AND request_payload = $10::jsonb
      `,
      [
        input.classificationJobId,
        idempotencyKey,
        input.provider,
        input.model,
        input.responseContractVersion,
        input.providerInstructionProfile,
        input.modelProfileVersion,
        input.structuredOutputMode,
        input.requestHash,
        input.requestPayload
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing classification provider job violates identity");
    }
    return existing.rows[0];
  }
}
