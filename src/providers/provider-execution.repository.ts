import type {
  JsonObject,
  PromptType,
  ProviderJobRow,
  ProviderName,
  ProviderResultRow,
  TokenUsageRow
} from "../types/database.types.js";
import { MockProviderRepository } from "./mock-provider.repository.js";

export type ProviderExecutionState = ProviderJobRow & {
  prompt_status: string;
  prompt_text: string | null;
  prompt_type: PromptType;
  prompt_version: string;
  analysis_run_id: string;
  analysis_run_status: string;
  anonymous_session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
};

export class ProviderExecutionRepository extends MockProviderRepository {
  async createOrReuseProviderResult(input: {
    providerJobId: string;
    provider: ProviderName;
    modelVersion: string;
    providerRequestId: string | null;
    rawResponse: JsonObject;
    parsedResponse: JsonObject;
    finishReason: string | null;
    latencyMs: number;
  }) {
    const idempotencyKey = `provider_result:${input.providerJobId}`;
    const rawResponse = JSON.stringify(input.rawResponse);
    const inserted = await this.database.query<ProviderResultRow>(
      `
        INSERT INTO provider_results (
          idempotency_key, provider_job_id, provider, status,
          provider_request_id, model_version, raw_response, parsed_response,
          validation_errors, finish_reason, latency_ms, received_at
        )
        VALUES (
          $1, $2, $3, 'valid', $4, $5, $6, $7,
          '[]'::jsonb, $8, $9, now()
        )
        ON CONFLICT (provider_job_id) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.providerJobId,
        input.provider,
        input.providerRequestId,
        input.modelVersion,
        rawResponse,
        input.parsedResponse,
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
          AND provider_request_id IS NOT DISTINCT FROM $4
          AND model_version = $5
          AND raw_response = $6
          AND parsed_response = $7::jsonb
          AND finish_reason IS NOT DISTINCT FROM $8
          AND latency_ms = $9
      `,
      [
        input.providerJobId,
        idempotencyKey,
        input.provider,
        input.providerRequestId,
        input.modelVersion,
        rawResponse,
        input.parsedResponse,
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
