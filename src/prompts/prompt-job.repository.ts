import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  PromptJobRow,
  PromptType
} from "../types/database.types.js";

export class PromptJobRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async createOrReuse(input: {
    llmRunId: string;
    promptType: PromptType;
    promptVersion: string;
  }) {
    const idempotencyKey =
      `prompt_job:${input.llmRunId}:${input.promptType}:${input.promptVersion}`;
    const inserted = await this.database.query<PromptJobRow>(
      `
        INSERT INTO prompt_jobs (
          idempotency_key,
          llm_run_id,
          prompt_type,
          prompt_version,
          status,
          prompt_text,
          input_payload
        )
        VALUES ($1, $2, $3, $4, 'pending', NULL, '{}'::jsonb)
        ON CONFLICT (llm_run_id, prompt_type, prompt_version) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.llmRunId,
        input.promptType,
        input.promptVersion
      ]
    );
    if (inserted.rows[0]) {
      return inserted.rows[0];
    }

    const existing = await this.database.query<PromptJobRow>(
      `
        SELECT *
        FROM prompt_jobs
        WHERE llm_run_id = $1
          AND prompt_type = $2
          AND prompt_version = $3
          AND idempotency_key = $4
      `,
      [
        input.llmRunId,
        input.promptType,
        input.promptVersion,
        idempotencyKey
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing prompt job violates its stable identity");
    }
    return existing.rows[0];
  }
}
