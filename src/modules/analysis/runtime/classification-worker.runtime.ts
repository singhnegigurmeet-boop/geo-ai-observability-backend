import type { ConsumerChannel } from "../../../common/messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "../../providers/runtime/reliable-queue-worker.runtime.js";
import type { ClassificationWorker } from "../workers/classification-worker.js";

export class ClassificationWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<ClassificationWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: { mainExchange: string; prefetch: number },
    logger: WorkerLogger = console
  ) {
    super(
      channel,
      worker,
      failures,
      {
        queueName: "domain_category_classification_queue",
        mainExchange: options.mainExchange,
        prefetch: options.prefetch,
        workerLabel: "Domain category classification worker"
      },
      logger
    );
  }
}
