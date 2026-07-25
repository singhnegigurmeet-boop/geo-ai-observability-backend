import type { QueueMessage } from "../../../common/messaging/queue-message.types.js";
import {
  isQueueName,
  type QueueName
} from "../../../common/messaging/queue-names.js";
import type { JsonObject } from "../../../common/types/database.types.js";
import type { OutboxRepositoryContract } from "../repositories/outbox.repository.js";
import type { ClaimedOutboxEvent } from "../types/outbox.types.js";

export interface QueuePublisher {
  publish(queueName: QueueName, message: QueueMessage): Promise<void>;
}

export type OutboxDispatcherOptions = {
  dispatcherId: string;
  batchSize: number;
  pollIntervalMs: number;
  lockTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
};

export type OutboxDispatcherLogger = Pick<
  Console,
  "error" | "info" | "warn"
>;

export class OutboxDispatcher {
  constructor(
    private readonly repository: OutboxRepositoryContract,
    private readonly publisher: QueuePublisher,
    private readonly options: OutboxDispatcherOptions,
    private readonly logger: OutboxDispatcherLogger = console,
    private readonly now: () => Date = () => new Date()
  ) {}

  async dispatchBatch() {
    const claimedAt = this.now();
    const events = await this.repository.claimBatch({
      dispatcherId: this.options.dispatcherId,
      batchSize: this.options.batchSize,
      lockTimeoutMs: this.options.lockTimeoutMs,
      now: claimedAt
    });

    for (const event of events) {
      await this.dispatchEvent(event);
    }
    return events.length;
  }

  async run(signal: AbortSignal) {
    this.logger.info(`Outbox dispatcher ${this.options.dispatcherId} started.`);

    while (!signal.aborted) {
      try {
        const claimed = await this.dispatchBatch();
        if (claimed === 0) {
          await abortableDelay(this.options.pollIntervalMs, signal);
        }
      } catch (error) {
        this.logger.error("Outbox dispatcher batch failed.", error);
        await abortableDelay(this.options.pollIntervalMs, signal);
      }
    }

    this.logger.info(`Outbox dispatcher ${this.options.dispatcherId} stopped.`);
  }

  private async dispatchEvent(event: ClaimedOutboxEvent) {
    try {
      const queueName = readQueueName(event.headers);
      const message = toQueueMessage(event);
      await this.publisher.publish(queueName, message);
      const publishedAt = this.now();

      const marked = await this.repository.markPublished(
        event.outbox_event_id,
        this.options.dispatcherId,
        publishedAt
      );
      if (!marked) {
        this.logger.warn(
          `Outbox event ${event.outbox_event_id} was confirmed but its lease was no longer owned.`
        );
      }
    } catch (error) {
      const normalized = normalizeError(error);
      const retryDelay = calculateRetryDelay(
        event.attempt_count,
        this.options.retryBaseMs,
        this.options.retryMaxMs
      );
      const failedAt = this.now();
      const marked = await this.repository.markFailed({
        outboxEventId: event.outbox_event_id,
        dispatcherId: this.options.dispatcherId,
        errorCode: normalized.code,
        errorMessage: normalized.message,
        availableAt: new Date(failedAt.getTime() + retryDelay),
        now: failedAt
      });
      if (!marked) {
        this.logger.warn(
          `Outbox event ${event.outbox_event_id} failed after its lease was lost.`
        );
      }
    }
  }
}

export function readQueueName(headers: JsonObject) {
  const queueName = headers.queueName;
  if (!isQueueName(queueName)) {
    const error = new Error("Outbox headers.queueName is missing or invalid");
    error.name = "InvalidOutboxRouteError";
    throw error;
  }
  return queueName;
}

export function toQueueMessage(event: ClaimedOutboxEvent): QueueMessage {
  return {
    messageId: event.event_key,
    eventType: event.event_type,
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    occurredAt: event.created_at.toISOString(),
    attempt: event.attempt_count,
    payload: event.payload
  };
}

export function calculateRetryDelay(
  attempt: number,
  baseMs: number,
  maxMs: number
) {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: unknown };
    return {
      code:
        typeof errorWithCode.code === "string"
          ? errorWithCode.code
          : error.name || "OUTBOX_PUBLISH_FAILED",
      message: error.message.slice(0, 4_000)
    };
  }
  return {
    code: "OUTBOX_PUBLISH_FAILED",
    message: String(error).slice(0, 4_000)
  };
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}
