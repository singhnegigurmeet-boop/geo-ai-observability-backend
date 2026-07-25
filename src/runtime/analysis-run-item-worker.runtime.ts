import type { AnalysisRunItemWorker } from "../analysis/analysis-run-item-worker.js";
import type { ConsumerChannel } from "../messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "./reliable-queue-worker.runtime.js";

export type AnalysisRunItemWorkerRuntimeOptions = {
  mainExchange: string;
  prefetch: number;
};

export class AnalysisRunItemWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<AnalysisRunItemWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: AnalysisRunItemWorkerRuntimeOptions,
    logger: WorkerLogger = console
  ) {
    super(
      channel,
      worker,
      failures,
      {
        queueName: "analysis_run_item_queue",
        mainExchange: options.mainExchange,
        prefetch: options.prefetch,
        workerLabel: "Analysis run item worker"
      },
      logger
    );
  }
}
