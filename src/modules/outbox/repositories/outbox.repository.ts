import type {
  Pool,
  PoolClient
} from "pg";
import type { ClaimedOutboxEvent, OutboxClaimOptions, OutboxFailure } from "../types/outbox.types.js";

export interface OutboxRepositoryContract {
  claimBatch(options: OutboxClaimOptions): Promise<ClaimedOutboxEvent[]>;
  markPublished(
    outboxEventId: string,
    dispatcherId: string,
    publishedAt: Date
  ): Promise<boolean>;
  markFailed(failure: OutboxFailure): Promise<boolean>;
}

export class OutboxRepository implements OutboxRepositoryContract {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async claimBatch(options: OutboxClaimOptions) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const events = await this.claimWithinTransaction(client, options);
      await client.query("COMMIT");
      return events;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markPublished(
    outboxEventId: string,
    dispatcherId: string,
    publishedAt: Date
  ) {
    const result = await this.pool.query(
      `
        UPDATE outbox_events
        SET status = 'published',
            published_at = $3,
            locked_at = NULL,
            locked_by = NULL,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = $3
        WHERE outbox_event_id = $1
          AND status = 'publishing'
          AND locked_by = $2
      `,
      [outboxEventId, dispatcherId, publishedAt]
    );
    return result.rowCount === 1;
  }

  async markFailed(failure: OutboxFailure) {
    const result = await this.pool.query(
      `
        UPDATE outbox_events
        SET status = 'failed',
            available_at = $3,
            locked_at = NULL,
            locked_by = NULL,
            last_error_code = $4,
            last_error_message = $5,
            updated_at = $6
        WHERE outbox_event_id = $1
          AND status = 'publishing'
          AND locked_by = $2
      `,
      [
        failure.outboxEventId,
        failure.dispatcherId,
        failure.availableAt,
        failure.errorCode,
        failure.errorMessage,
        failure.now
      ]
    );
    return result.rowCount === 1;
  }

  private async claimWithinTransaction(
    client: PoolClient,
    options: OutboxClaimOptions
  ) {
    const staleBefore = new Date(options.now.getTime() - options.lockTimeoutMs);
    const result = await client.query<ClaimedOutboxEvent>(
      `
        WITH candidates AS (
          SELECT outbox_event_id
          FROM outbox_events
          WHERE (
              status IN ('pending', 'failed')
              AND available_at <= $3
            )
            OR (
              status = 'publishing'
              AND locked_at <= $4
            )
          ORDER BY available_at ASC, outbox_event_id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE outbox_events AS event
        SET status = 'publishing',
            attempt_count = event.attempt_count + 1,
            locked_at = $3,
            locked_by = $2,
            updated_at = $3
        FROM candidates
        WHERE event.outbox_event_id = candidates.outbox_event_id
        RETURNING event.*
      `,
      [
        options.batchSize,
        options.dispatcherId,
        options.now,
        staleBefore
      ]
    );
    return result.rows;
  }
}
