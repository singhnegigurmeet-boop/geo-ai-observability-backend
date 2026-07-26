import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  PromptJobRow,
  PromptDepth,
  PromptType
} from "../../../common/types/database.types.js";
import type { EntityPathContext } from "../types/prompt-rendering.types.js";
import { entityPathContextSchema } from "../contracts/entity-path-context.contract.js";

export class PromptJobRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async createOrReuse(input: {
    llmRunId: string;
    promptType: PromptType;
    promptDepth: PromptDepth;
    businessPromptVersion: string;
    responseContractVersion: string;
    entityPathContext: EntityPathContext;
  }) {
    const parsedContext = entityPathContextSchema.safeParse(
      input.entityPathContext
    );
    if (!parsedContext.success) {
      throw new Error(
        "Entity path context violates its authoritative runtime contract"
      );
    }
    const idempotencyKey =
      `prompt_job:${input.llmRunId}:${input.promptType}:${input.businessPromptVersion}:${input.promptDepth}`;
    const inserted = await this.database.query<PromptJobRow>(
      `
        INSERT INTO prompt_jobs (
          idempotency_key,
          llm_run_id,
          prompt_type,
          prompt_depth,
          business_prompt_version,
          response_contract_version,
          status,
          prompt_text,
          input_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', NULL, $7)
        ON CONFLICT (
          llm_run_id, prompt_type, business_prompt_version, prompt_depth
        ) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.llmRunId,
        input.promptType,
        input.promptDepth,
        input.businessPromptVersion,
        input.responseContractVersion,
        { entityPathContext: parsedContext.data }
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
          AND business_prompt_version = $3
          AND prompt_depth = $4
          AND response_contract_version = $5
          AND input_payload = $6::jsonb
          AND idempotency_key = $7
      `,
      [
        input.llmRunId,
        input.promptType,
        input.businessPromptVersion,
        input.promptDepth,
        input.responseContractVersion,
        { entityPathContext: parsedContext.data },
        idempotencyKey
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing prompt job violates its stable identity");
    }
    return existing.rows[0];
  }
}
