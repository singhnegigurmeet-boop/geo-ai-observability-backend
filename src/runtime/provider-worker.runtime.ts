import type { ConsumerChannel } from "../messaging/rabbitmq.consumer.js";
import type { QueueName } from "../messaging/queue-names.js";
import type { ProviderWorker } from "../providers/provider-worker.js";
import type { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "./reliable-queue-worker.runtime.js";

export class ProviderWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<ProviderWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: {
      queueName: Extract<
        QueueName,
        "openai_queue" | "gemini_queue" | "claude_queue"
      >;
      mainExchange: string;
      prefetch: number;
      workerLabel: string;
    },
    logger: WorkerLogger = console
  ) {
    super(channel, worker, failures, options, logger);
  }
}
