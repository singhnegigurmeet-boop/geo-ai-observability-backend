import type { ConsumerChannel } from "../../../common/messaging/rabbitmq.consumer.js";
import type { PromptQueueName } from "../../../common/messaging/queue-names.js";
import type { PromptWorker } from "../workers/prompt-worker.js";
import type { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "../../providers/runtime/reliable-queue-worker.runtime.js";

export type PromptWorkerRuntimeOptions = {
  queueName: PromptQueueName;
  mainExchange: string;
  prefetch: number;
};

export class PromptWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<PromptWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: PromptWorkerRuntimeOptions,
    logger: WorkerLogger = console
  ) {
    super(
      channel,
      worker,
      failures,
      {
        queueName: options.queueName,
        mainExchange: options.mainExchange,
        prefetch: options.prefetch,
        workerLabel: `${options.queueName} worker`
      },
      logger
    );
  }
}
