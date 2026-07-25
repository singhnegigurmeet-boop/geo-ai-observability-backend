import type { ConsumerChannel } from "../../../common/messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import type { ProviderScoreWorker } from "../workers/provider-score-worker.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "../../providers/runtime/reliable-queue-worker.runtime.js";

export type ProviderScoreWorkerRuntimeOptions = {
  mainExchange: string;
  prefetch: number;
};

export class ProviderScoreWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<ProviderScoreWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: ProviderScoreWorkerRuntimeOptions,
    logger: WorkerLogger = console
  ) {
    super(
      channel,
      worker,
      failures,
      {
        queueName: "scoring_queue",
        mainExchange: options.mainExchange,
        prefetch: options.prefetch,
        workerLabel: "Provider score worker"
      },
      logger
    );
  }
}
