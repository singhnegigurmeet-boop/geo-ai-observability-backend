import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  JsonObject,
  PromptType,
  ProviderJobRow,
  ProviderResultRow,
  TokenUsageRow
} from "../types/database.types.js";

export type MockProviderExecutionState = ProviderJobRow & {
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

export class MockProviderRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findForUpdate(providerJobId: string) {
    const result = await this.database.query<MockProviderExecutionState>(
      `
        SELECT
          provider_job.*,
          prompt.status AS prompt_status,
          prompt.prompt_text,
          prompt.prompt_type,
          prompt.prompt_version,
          item.analysis_run_id,
          run.status AS analysis_run_status,
          run.anonymous_session_id,
          run.user_id,
          run.workspace_id
        FROM provider_jobs AS provider_job
        JOIN prompt_jobs AS prompt
          ON prompt.prompt_job_id = provider_job.prompt_job_id
        JOIN llm_runs AS llm
          ON llm.llm_run_id = prompt.llm_run_id
        JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        JOIN analysis_runs AS run
          ON run.analysis_run_id = item.analysis_run_id
        WHERE provider_job.provider_job_id = $1
        FOR UPDATE OF provider_job, prompt
      `,
      [providerJobId]
    );
    return result.rows[0] ?? null;
  }

  async createOrReuseResult(input: {
    providerJobId: string;
    model: string;
    parsedResponse: JsonObject;
    rawResponse: string;
  }) {
    const idempotencyKey = `provider_result:${input.providerJobId}`;
    const inserted = await this.database.query<ProviderResultRow>(
      `
        INSERT INTO provider_results (
          idempotency_key,
          provider_job_id,
          provider,
          status,
          provider_request_id,
          model_version,
          raw_response,
          parsed_response,
          validation_errors,
          finish_reason,
          latency_ms,
          received_at
        )
        VALUES (
          $1, $2, 'mock', 'valid', $3, $4, $5, $6,
          '[]'::jsonb, 'mock_complete', 0, now()
        )
        ON CONFLICT (provider_job_id) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.providerJobId,
        `mock:${input.providerJobId}`,
        input.model,
        input.rawResponse,
        input.parsedResponse
      ]
    );
    if (inserted.rows[0]) {
      return inserted.rows[0];
    }
    const existing = await this.database.query<ProviderResultRow>(
      `
        SELECT *
        FROM provider_results
        WHERE provider_job_id = $1
          AND idempotency_key = $2
          AND provider = 'mock'
          AND status = 'valid'
          AND provider_request_id = $3
          AND model_version = $4
          AND raw_response = $5
          AND parsed_response = $6::jsonb
      `,
      [
        input.providerJobId,
        idempotencyKey,
        `mock:${input.providerJobId}`,
        input.model,
        input.rawResponse,
        input.parsedResponse
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing mock provider result violates stable evidence");
    }
    return existing.rows[0];
  }

  async createOrReuseActualUsage(input: {
    providerJobId: string;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  }) {
    const idempotencyKey = `token_usage:${input.providerJobId}:actual`;
    const inserted = await this.database.query<TokenUsageRow>(
      `
        INSERT INTO token_usage (
          idempotency_key,
          provider_job_id,
          usage_kind,
          input_tokens,
          output_tokens,
          cached_tokens,
          reasoning_tokens,
          cost_micros
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
    if (inserted.rows[0]) {
      return inserted.rows[0];
    }
    const existing = await this.database.query<TokenUsageRow>(
      `
        SELECT *
        FROM token_usage
        WHERE provider_job_id = $1
          AND usage_kind = 'actual'
          AND idempotency_key = $2
          AND input_tokens = $3
          AND output_tokens = $4
          AND cached_tokens = 0
          AND reasoning_tokens = 0
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
      throw new Error("Existing mock token usage violates stable evidence");
    }
    return existing.rows[0];
  }

  async markSucceeded(providerJobId: string, promptJobId: string) {
    const provider = await this.database.query<{ provider_job_id: string }>(
      `
        UPDATE provider_jobs
        SET status = 'succeeded',
            started_at = COALESCE(started_at, now()),
            completed_at = now(),
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE provider_job_id = $1 AND status = 'queued'
        RETURNING provider_job_id
      `,
      [providerJobId]
    );
    const prompt = await this.database.query<{ prompt_job_id: string }>(
      `
        UPDATE prompt_jobs
        SET status = 'succeeded',
            completed_at = now(),
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE prompt_job_id = $1
          AND status = 'processing'
          AND prompt_text IS NOT NULL
          AND length(btrim(prompt_text)) > 0
        RETURNING prompt_job_id
      `,
      [promptJobId]
    );
    return Boolean(provider.rows[0] && prompt.rows[0]);
  }

  async markBudgetPaused(input: {
    providerJobId: string;
    promptJobId: string;
    analysisRunId: string;
    reasonCode: string;
    reasonMessage: string;
  }) {
    const provider = await this.database.query<{ provider_job_id: string }>(
      `
        UPDATE provider_jobs
        SET status = 'paused_budget',
            error_code = $2,
            error_message = $3,
            updated_at = now()
        WHERE provider_job_id = $1
          AND status IN ('pending', 'queued', 'processing')
        RETURNING provider_job_id
      `,
      [input.providerJobId, input.reasonCode, input.reasonMessage]
    );
    const prompt = await this.database.query<{ prompt_job_id: string }>(
      `
        UPDATE prompt_jobs
        SET status = 'paused_budget',
            error_code = $2,
            error_message = $3,
            updated_at = now()
        WHERE prompt_job_id = $1
          AND status IN ('pending', 'queued', 'processing')
        RETURNING prompt_job_id
      `,
      [input.promptJobId, input.reasonCode, input.reasonMessage]
    );
    await this.database.query(
      `
        UPDATE llm_runs AS llm
        SET status = 'paused_budget',
            error_code = $2,
            error_message = $3,
            updated_at = now()
        FROM analysis_run_items AS item
        WHERE llm.analysis_run_item_id = item.analysis_run_item_id
          AND item.analysis_run_id = $1
          AND llm.status IN ('queued', 'processing')
      `,
      [input.analysisRunId, input.reasonCode, input.reasonMessage]
    );
    await this.database.query(
      `
        UPDATE analysis_run_items
        SET status = 'paused_budget',
            error_code = $2,
            error_message = $3,
            updated_at = now()
        WHERE analysis_run_id = $1
          AND status IN ('queued', 'processing')
      `,
      [input.analysisRunId, input.reasonCode, input.reasonMessage]
    );
    await this.database.query(
      `
        UPDATE analysis_runs
        SET status = 'paused_budget',
            error_code = $2,
            error_message = $3,
            updated_at = now()
        WHERE analysis_run_id = $1
          AND status IN ('queued', 'processing')
      `,
      [input.analysisRunId, input.reasonCode, input.reasonMessage]
    );
    return Boolean(provider.rows[0] && prompt.rows[0]);
  }
}
