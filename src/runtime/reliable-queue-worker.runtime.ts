import { createHash } from "node:crypto";
import type { ConsumeMessage, Options } from "amqplib";
import {
  WORKER_ATTEMPT_HEADER,
  publishConfirmed,
  readWorkerAttempt,
  startConsumer,
  type ConsumerChannel
} from "../messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../reliability/failure-record.repository.js";

export type ReliableQueueWorkerOptions = {
  queueName: string;
  mainExchange: string;
  prefetch: number;
  workerLabel: string;
};

export type WorkerLogger = Pick<Console, "error" | "info" | "warn">;

export class ReliableQueueWorkerRuntime {
  private consumerTag: string | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly channel: ConsumerChannel,
    private readonly worker: { process(input: unknown): Promise<unknown> },
    private readonly failures: Pick<FailureRecordRepository, "createOrReuse">,
    private readonly options: ReliableQueueWorkerOptions,
    private readonly logger: WorkerLogger = console
  ) {}

  async start() {
    if (this.consumerTag) {
      return;
    }
    const consumer = await startConsumer(
      this.channel,
      this.options.queueName,
      this.options.prefetch,
      (message) => this.track(this.handleDelivery(message))
    );
    this.consumerTag = consumer.consumerTag;
    this.logger.info(
      `${this.options.workerLabel} consuming ${this.options.queueName}.`
    );
  }

  async stop() {
    const consumerTag = this.consumerTag;
    this.consumerTag = null;
    if (consumerTag) {
      await this.channel.cancel(consumerTag);
    }
    await Promise.allSettled(this.inFlight);
    this.logger.info(`${this.options.workerLabel} stopped.`);
  }

  async handleDelivery(message: ConsumeMessage) {
    const attempt = readWorkerAttempt(message);
    const identity = messageIdentity(message);

    try {
      const input = JSON.parse(message.content.toString("utf8")) as unknown;
      await this.worker.process(input);
      this.channel.ack(message);
    } catch (error) {
      const normalized = normalizeWorkerError(error);
      try {
        await this.failures.createOrReuse({
          queueName: this.options.queueName,
          messageId: identity.messageId,
          aggregateType: identity.aggregateType,
          aggregateId: identity.aggregateId,
          attemptNumber: attempt,
          errorCode: normalized.code,
          errorMessage: normalized.message,
          errorDetails: { permanent: normalized.permanent }
        });
      } catch (recordError) {
        this.logger.error(
          `Could not record ${this.options.workerLabel} failure.`,
          recordError
        );
        this.channel.nack(message, false, true);
        return;
      }

      if (normalized.permanent || attempt >= 3) {
        this.channel.nack(message, false, false);
        return;
      }

      try {
        await publishConfirmed(
          this.channel,
          this.options.mainExchange,
          this.options.queueName,
          message.content,
          retryProperties(message, attempt + 1)
        );
        this.channel.ack(message);
      } catch (publishError) {
        this.logger.error(
          `Could not publish ${this.options.workerLabel} retry.`,
          publishError
        );
        this.channel.nack(message, false, true);
      }
    }
  }

  private track(processing: Promise<void>) {
    this.inFlight.add(processing);
    void processing
      .finally(() => this.inFlight.delete(processing))
      .catch((error) => {
        this.logger.error(
          `${this.options.workerLabel} delivery escaped handling.`,
          error
        );
      });
    return processing;
  }
}

function retryProperties(
  message: ConsumeMessage,
  nextAttempt: number
): Options.Publish {
  return {
    contentType: message.properties.contentType,
    contentEncoding: message.properties.contentEncoding,
    persistent: true,
    messageId: message.properties.messageId,
    type: message.properties.type,
    timestamp: message.properties.timestamp,
    correlationId: message.properties.correlationId,
    headers: {
      ...(message.properties.headers ?? {}),
      [WORKER_ATTEMPT_HEADER]: nextAttempt
    }
  };
}

function messageIdentity(message: ConsumeMessage) {
  const contentId = createHash("sha256")
    .update(message.content)
    .digest("hex");
  return {
    messageId: message.properties.messageId || `malformed:${contentId}`,
    aggregateType: readStringHeader(message, "aggregateType") ?? null,
    aggregateId: readStringHeader(message, "aggregateId") ?? null
  };
}

function readStringHeader(message: ConsumeMessage, name: string) {
  const value = message.properties.headers?.[name];
  return typeof value === "string" ? value : undefined;
}

function normalizeWorkerError(error: unknown) {
  if (error instanceof Error) {
    const coded = error as Error & {
      code?: unknown;
      permanent?: unknown;
    };
    return {
      code:
        typeof coded.code === "string"
          ? coded.code
          : error.name || "QUEUE_WORKER_FAILED",
      message: error.message || "Queue worker failed",
      permanent: error instanceof SyntaxError || coded.permanent === true
    };
  }
  return {
    code: "QUEUE_WORKER_FAILED",
    message: String(error),
    permanent: false
  };
}
