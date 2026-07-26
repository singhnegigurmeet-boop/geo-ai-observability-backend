import type { ConsumerChannel } from "../../../common/messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "../../providers/runtime/reliable-queue-worker.runtime.js";
import type { ClassificationResultWorker } from "../workers/classification-result-worker.js";

export class ClassificationResultWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<ClassificationResultWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: { mainExchange: string; prefetch: number },
    logger: WorkerLogger = console
  ) {
    super(
      channel,
      worker,
      failures,
      {
        queueName: "domain_category_classification_result_queue",
        mainExchange: options.mainExchange,
        prefetch: options.prefetch,
        workerLabel: "Domain category classification result worker"
      },
      logger
    );
  }
}
