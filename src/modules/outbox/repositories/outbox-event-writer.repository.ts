import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  JsonObject,
  OutboxEventRow
} from "../../../common/types/database.types.js";

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

  async createOrReuse(input: CreateOutboxEventRecord) {
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
        ON CONFLICT (event_key) DO NOTHING
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
    if (result.rows[0]) {
      return result.rows[0];
    }
    const existing = await this.database.query<OutboxEventRow>(
      `
        SELECT *
        FROM outbox_events
        WHERE event_key = $1
          AND aggregate_type = $2
          AND aggregate_id = $3
          AND event_type = $4
          AND event_version = $5
          AND payload = $6::jsonb
          AND headers = $7::jsonb
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
    if (!existing.rows[0]) {
      throw new Error("Idempotent outbox event could not be loaded");
    }
    return existing.rows[0];
  }
}
