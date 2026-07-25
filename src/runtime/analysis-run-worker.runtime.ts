import { createHash } from "node:crypto";
import type { ConsumeMessage, Options } from "amqplib";
import type { AnalysisRunWorker } from "../analysis/analysis-run-worker.js";
import {
  InvalidAnalysisRunMessageError
} from "../analysis/analysis-run-worker.messages.js";
import { PermanentAnalysisRunError } from "../analysis/analysis-run-expansion.service.js";
import {
  WORKER_ATTEMPT_HEADER,
  publishConfirmed,
  readWorkerAttempt,
  startConsumer,
  type ConsumerChannel
} from "../messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../reliability/failure-record.repository.js";

const QUEUE_NAME = "analysis_run_queue";

export type AnalysisRunWorkerRuntimeOptions = {
  mainExchange: string;
  prefetch: number;
};

export type WorkerLogger = Pick<Console, "error" | "info" | "warn">;

export class AnalysisRunWorkerRuntime {
  private consumerTag: string | null = null;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly channel: ConsumerChannel,
    private readonly worker: Pick<AnalysisRunWorker, "process">,
    private readonly failures: Pick<FailureRecordRepository, "createOrReuse">,
    private readonly options: AnalysisRunWorkerRuntimeOptions,
    private readonly logger: WorkerLogger = console
  ) {}

  async start() {
    if (this.consumerTag) {
      return;
    }
    const consumer = await startConsumer(
      this.channel,
      QUEUE_NAME,
      this.options.prefetch,
      (message) => {
        const processing = this.handleDelivery(message);
        this.inFlight.add(processing);
        void processing
          .finally(() => this.inFlight.delete(processing))
          .catch((error) => {
            this.logger.error("Analysis worker delivery escaped handling.", error);
          });
        return processing;
      }
    );
    this.consumerTag = consumer.consumerTag;
    this.logger.info(`Analysis run worker consuming ${QUEUE_NAME}.`);
  }

  async stop() {
    const consumerTag = this.consumerTag;
    this.consumerTag = null;
    if (consumerTag) {
      await this.channel.cancel(consumerTag);
    }
    await Promise.allSettled(this.inFlight);
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
          queueName: QUEUE_NAME,
          messageId: identity.messageId,
          aggregateType: normalized.aggregateType ?? identity.aggregateType,
          aggregateId: normalized.aggregateId ?? identity.aggregateId,
          attemptNumber: attempt,
          errorCode: normalized.code,
          errorMessage: normalized.message,
          errorDetails: { permanent: normalized.permanent }
        });
      } catch (recordError) {
        this.logger.error("Could not record analysis worker failure.", recordError);
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
          QUEUE_NAME,
          message.content,
          retryProperties(message, attempt + 1)
        );
        this.channel.ack(message);
      } catch (publishError) {
        this.logger.error("Could not publish analysis worker retry.", publishError);
        this.channel.nack(message, false, true);
      }
    }
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
    aggregateType:
      readStringHeader(message, "aggregateType") ?? null,
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
      aggregateType?: unknown;
      aggregateId?: unknown;
    };
    return {
      code:
        typeof coded.code === "string"
          ? coded.code
          : error.name || "ANALYSIS_RUN_WORKER_FAILED",
      message: error.message || "Analysis run worker failed",
      permanent:
        error instanceof SyntaxError ||
        error instanceof InvalidAnalysisRunMessageError ||
        error instanceof PermanentAnalysisRunError ||
        coded.permanent === true,
      aggregateType:
        typeof coded.aggregateType === "string"
          ? coded.aggregateType
          : null,
      aggregateId:
        typeof coded.aggregateId === "string" ? coded.aggregateId : null
    };
  }
  return {
    code: "ANALYSIS_RUN_WORKER_FAILED",
    message: String(error),
    permanent: false,
    aggregateType: null,
    aggregateId: null
  };
}
