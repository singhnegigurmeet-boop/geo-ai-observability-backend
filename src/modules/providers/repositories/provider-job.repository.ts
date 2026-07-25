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
    requestPayload: JsonObject;
  }) {
    const idempotencyKey =
      `provider_job:${input.promptJobId}:${input.provider}:${input.model}`;
    const inserted = await this.database.query<ProviderJobRow>(
      `
        INSERT INTO provider_jobs (
          idempotency_key,
          prompt_job_id,
          provider,
          model,
          status,
          request_payload
        )
        VALUES ($1, $2, $3, $4, 'queued', $5)
        ON CONFLICT (prompt_job_id, provider, model) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.promptJobId,
        input.provider,
        input.model,
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
          AND request_payload = $5::jsonb
      `,
      [
        input.promptJobId,
        input.provider,
        input.model,
        idempotencyKey,
        input.requestPayload
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing provider job violates its stable identity");
    }
    return existing.rows[0];
  }
}
