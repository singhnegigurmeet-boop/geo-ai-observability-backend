import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  PromptType,
  PromptDepth,
  ProviderJobRow,
  TokenUsageRow
} from "../../../common/types/database.types.js";

export type MockProviderExecutionState = ProviderJobRow & {
  prompt_status: string;
  prompt_text: string | null;
  prompt_type: PromptType | null;
  prompt_depth: PromptDepth | null;
  business_prompt_version: string | null;
  response_contract_version: string;
  analysis_run_id: string;
  analysis_run_status: string;
  anonymous_session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
};

export class MockProviderRepository {
  constructor(protected readonly database: DatabaseExecutor) {}

  async findForUpdate(providerJobId: string) {
    const result = await this.database.query<MockProviderExecutionState>(
      `
        SELECT
          provider_job.*,
          prompt.status AS prompt_status,
          prompt.prompt_text,
          prompt.prompt_type,
          prompt.prompt_depth,
          prompt.business_prompt_version,
          prompt.response_contract_version,
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
        FOR UPDATE OF run, item, llm, prompt, provider_job
      `,
      [providerJobId]
    );
    return result.rows[0] ?? null;
  }

  async markProcessing(providerJobId: string) {
    const result = await this.database.query<{ provider_job_id: string }>(
      `
        UPDATE provider_jobs
        SET status = 'processing',
            started_at = COALESCE(started_at, now()),
            updated_at = now()
        WHERE provider_job_id = $1
          AND status = 'queued'
        RETURNING provider_job_id
      `,
      [providerJobId]
    );
    return Boolean(result.rows[0]);
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

  async markSucceeded(providerJobId: string) {
    const provider = await this.database.query<{ provider_job_id: string }>(
      `
        UPDATE provider_jobs
        SET status = 'succeeded',
            started_at = COALESCE(started_at, now()),
            completed_at = now(),
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE provider_job_id = $1 AND status = 'processing'
        RETURNING provider_job_id
      `,
      [providerJobId]
    );
    return Boolean(provider.rows[0]);
  }

  async markFailed(
    providerJobId: string,
    errorCode: string,
    errorMessage: string
  ) {
    const result = await this.database.query<{ provider_job_id: string }>(
      `
        UPDATE provider_jobs
        SET status = 'failed',
            started_at = COALESCE(started_at, now()),
            completed_at = COALESCE(completed_at, now()),
            error_code = $2,
            error_message = $3,
            updated_at = now()
        WHERE provider_job_id = $1
          AND status IN ('pending', 'queued', 'processing')
        RETURNING provider_job_id
      `,
      [providerJobId, errorCode, errorMessage]
    );
    return Boolean(result.rows[0]);
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
    await this.database.query(
      `
        UPDATE provider_jobs AS job
        SET status = 'paused_budget',
            error_code = $2,
            error_message = $3,
            updated_at = now()
        FROM prompt_jobs AS prompt
        JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
        JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        WHERE job.prompt_job_id = prompt.prompt_job_id
          AND item.analysis_run_id = $1
          AND job.status IN ('pending', 'queued')
      `,
      [input.analysisRunId, input.reasonCode, input.reasonMessage]
    );
    return Boolean(provider.rows[0]);
  }
}
