import type { AnalysisRunWorker } from "../workers/analysis-run-worker.js";
import type { ConsumerChannel } from "../../../common/messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "../../providers/runtime/reliable-queue-worker.runtime.js";

export type AnalysisRunWorkerRuntimeOptions = {
  mainExchange: string;
  prefetch: number;
};

export { type WorkerLogger };

export class AnalysisRunWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<AnalysisRunWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: AnalysisRunWorkerRuntimeOptions,
    logger: WorkerLogger = console
  ) {
    super(
      channel,
      worker,
      failures,
      {
        queueName: "analysis_run_queue",
        mainExchange: options.mainExchange,
        prefetch: options.prefetch,
        workerLabel: "Analysis run worker"
      },
      logger
    );
  }
}
