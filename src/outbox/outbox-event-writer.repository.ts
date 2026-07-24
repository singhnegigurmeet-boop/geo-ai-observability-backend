import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  JsonObject,
  OutboxEventRow
} from "../types/database.types.js";

export type CreateOutboxEventRecord = {
  eventKey: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: JsonObject;
  headers: JsonObject;
};

export class OutboxEventWriterRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async create(input: CreateOutboxEventRecord) {
    const result = await this.database.query<OutboxEventRow>(
      `
        INSERT INTO outbox_events (
          event_key,
          aggregate_type,
          aggregate_id,
          event_type,
          event_version,
          payload,
          headers
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        input.eventKey,
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        input.eventVersion,
        input.payload,
        input.headers
      ]
    );
    return result.rows[0] as OutboxEventRow;
  }
}
