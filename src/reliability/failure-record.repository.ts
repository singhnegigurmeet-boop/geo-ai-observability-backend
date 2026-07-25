import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  FailureRecordRow,
  JsonObject
} from "../types/database.types.js";

export type RecordWorkerFailure = {
  queueName: string;
  messageId: string;
  aggregateType: string | null;
  aggregateId: string | null;
  attemptNumber: number;
  errorCode: string | null;
  errorMessage: string;
  errorDetails?: JsonObject;
};

export class FailureRecordRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async createOrReuse(input: RecordWorkerFailure) {
    const result = await this.database.query<FailureRecordRow>(
      `
        INSERT INTO failure_records (
          queue_name,
          message_id,
          aggregate_type,
          aggregate_id,
          attempt_number,
          error_code,
          error_message,
          error_details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (queue_name, message_id, attempt_number) DO NOTHING
        RETURNING *
      `,
      [
        input.queueName,
        input.messageId,
        input.aggregateType,
        input.aggregateId,
        input.attemptNumber,
        input.errorCode,
        input.errorMessage.slice(0, 4_000),
        input.errorDetails ?? {}
      ]
    );
    if (result.rows[0]) {
      return result.rows[0];
    }
    const existing = await this.database.query<FailureRecordRow>(
      `
        SELECT *
        FROM failure_records
        WHERE queue_name = $1
          AND message_id = $2
          AND attempt_number = $3
      `,
      [input.queueName, input.messageId, input.attemptNumber]
    );
    if (!existing.rows[0]) {
      throw new Error("Idempotent failure record could not be loaded");
    }
    return existing.rows[0];
  }
}
