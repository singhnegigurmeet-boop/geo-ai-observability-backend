import type { LlmRunWorker } from "../llm/llm-run-worker.js";
import type { ConsumerChannel } from "../messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "./reliable-queue-worker.runtime.js";

export type LlmRunWorkerRuntimeOptions = {
  mainExchange: string;
  prefetch: number;
};

export class LlmRunWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<LlmRunWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: LlmRunWorkerRuntimeOptions,
    logger: WorkerLogger = console
  ) {
    super(
      channel,
      worker,
      failures,
      {
        queueName: "llm_run_queue",
        mainExchange: options.mainExchange,
        prefetch: options.prefetch,
        workerLabel: "LLM run worker"
      },
      logger
    );
  }
}
