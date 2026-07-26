import type {
  JsonObject,
  JsonValue,
  PromptType,
  PromptDepth,
  ProviderJobRow,
  ProviderName,
  ProviderResultRow,
  TokenUsageRow
} from "../../../common/types/database.types.js";
import { MockProviderRepository } from "./mock-provider.repository.js";

export type ProviderExecutionState = ProviderJobRow & {
  prompt_status: string;
  prompt_text: string | null;
  prompt_type: PromptType | null;
  prompt_depth: PromptDepth | null;
  business_prompt_version: string | null;
  response_contract_version: string;
  classification_status: string | null;
  classification_input_payload: JsonObject | null;
  analysis_run_id: string;
  analysis_run_status: string;
  anonymous_session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
};

export class ProviderExecutionRepository extends MockProviderRepository {
  async lockAnalysisRunForProviderJob(providerJobId: string) {
    await this.database.query(
      `SELECT pg_advisory_xact_lock(
         COALESCE(item.analysis_run_id, classification.analysis_run_id)
       )
       FROM provider_jobs AS job
       LEFT JOIN prompt_jobs AS prompt
         ON prompt.prompt_job_id = job.prompt_job_id
       LEFT JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
       LEFT JOIN analysis_run_items AS item
         ON item.analysis_run_item_id = llm.analysis_run_item_id
       LEFT JOIN domain_category_classification_jobs AS classification
         ON classification.domain_category_classification_job_id =
            job.classification_job_id
       WHERE job.provider_job_id = $1`,
      [providerJobId]
    );
  }

  async findForUpdate(providerJobId: string) {
    const result = await this.database.query<ProviderExecutionState>(
      `
        SELECT
          job.*,
          prompt.status AS prompt_status,
          COALESCE(prompt.prompt_text, classification.rendered_prompt)
            AS prompt_text,
          prompt.prompt_type,
          prompt.prompt_depth,
          prompt.business_prompt_version,
          classification.status AS classification_status,
          classification.input_payload AS classification_input_payload,
          run.analysis_run_id,
          run.status AS analysis_run_status,
          run.anonymous_session_id,
          run.user_id,
          run.workspace_id
        FROM provider_jobs AS job
        LEFT JOIN prompt_jobs AS prompt
          ON prompt.prompt_job_id = job.prompt_job_id
        LEFT JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
        LEFT JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        LEFT JOIN domain_category_classification_jobs AS classification
          ON classification.domain_category_classification_job_id =
             job.classification_job_id
        JOIN analysis_runs AS run
          ON run.analysis_run_id =
             COALESCE(item.analysis_run_id, classification.analysis_run_id)
        WHERE job.provider_job_id = $1
        FOR UPDATE OF job, run
      `,
      [providerJobId]
    );
    return result.rows[0] ?? null;
  }

  async createOrReuseProviderResult(input: {
    providerJobId: string;
    provider: ProviderName;
    responseContractVersion: string;
    modelVersion: string;
    providerRequestId: string | null;
    rawResponse: string;
    rawResponseTruncated: boolean;
    rawResponseOriginalBytes: number;
    providerMetadata: JsonObject;
    validatedResponse: JsonObject | null;
    validationErrors: JsonValue[];
    contextValidationStatus: "valid" | "invalid";
    finishReason: string | null;
    latencyMs: number;
  }) {
    const idempotencyKey = `provider_result:${input.providerJobId}`;
    const status = input.validatedResponse === null ? "invalid" : "valid";
    const inserted = await this.database.query<ProviderResultRow>(
      `
        INSERT INTO provider_results (
          idempotency_key, provider_job_id, provider, status,
          response_contract_version, provider_request_id, model_version,
          raw_response, raw_response_truncated, raw_response_original_bytes,
          provider_metadata, validated_response, validation_errors,
          context_validation_status, finish_reason, latency_ms, received_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, now()
        )
        ON CONFLICT (provider_job_id) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.providerJobId,
        input.provider,
        status,
        input.responseContractVersion,
        input.providerRequestId,
        input.modelVersion,
        input.rawResponse,
        input.rawResponseTruncated,
        input.rawResponseOriginalBytes,
        input.providerMetadata,
        input.validatedResponse,
        JSON.stringify(input.validationErrors),
        input.contextValidationStatus,
        input.finishReason,
        input.latencyMs
      ]
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.database.query<ProviderResultRow>(
      `
        SELECT *
        FROM provider_results
        WHERE provider_job_id = $1
          AND idempotency_key = $2
          AND provider = $3
          AND status = $4
          AND response_contract_version = $5
          AND provider_request_id IS NOT DISTINCT FROM $6
          AND model_version = $7
          AND raw_response = $8
          AND raw_response_truncated = $9
          AND raw_response_original_bytes = $10
          AND provider_metadata = $11::jsonb
          AND validated_response IS NOT DISTINCT FROM $12::jsonb
          AND validation_errors = $13::jsonb
          AND context_validation_status = $14
          AND finish_reason IS NOT DISTINCT FROM $15
          AND latency_ms = $16
      `,
      [
        input.providerJobId,
        idempotencyKey,
        input.provider,
        status,
        input.responseContractVersion,
        input.providerRequestId,
        input.modelVersion,
        input.rawResponse,
        input.rawResponseTruncated,
        input.rawResponseOriginalBytes,
        input.providerMetadata,
        input.validatedResponse,
        JSON.stringify(input.validationErrors),
        input.contextValidationStatus,
        input.finishReason,
        input.latencyMs
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing provider result violates stable evidence");
    }
    return existing.rows[0];
  }

  async createOrReuseProviderActualUsage(input: {
    providerJobId: string;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  }) {
    const idempotencyKey = `token_usage:${input.providerJobId}:actual`;
    const inserted = await this.database.query<TokenUsageRow>(
      `
        INSERT INTO token_usage (
          idempotency_key, provider_job_id, usage_kind,
          input_tokens, output_tokens, cached_tokens,
          reasoning_tokens, cost_micros
        )
        VALUES ($1, $2, 'actual', $3, $4, 0, 0, $5)
        ON CONFLICT (provider_job_id, usage_kind) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.providerJobId,
        input.inputTokens,
        input.outputTokens,
        input.costMicros
      ]
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing = await this.database.query<TokenUsageRow>(
      `
        SELECT *
        FROM token_usage
        WHERE provider_job_id = $1
          AND usage_kind = 'actual'
          AND idempotency_key = $2
          AND input_tokens = $3
          AND output_tokens = $4
          AND cost_micros = $5
      `,
      [
        input.providerJobId,
        idempotencyKey,
        input.inputTokens,
        input.outputTokens,
        input.costMicros
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing actual usage violates stable accounting");
    }
    return existing.rows[0];
  }
}
