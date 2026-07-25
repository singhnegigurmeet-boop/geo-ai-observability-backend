import type { AnalysisRunItemWorker } from "../workers/analysis-run-item-worker.js";
import type { ConsumerChannel } from "../../../common/messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "../../providers/runtime/reliable-queue-worker.runtime.js";

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
