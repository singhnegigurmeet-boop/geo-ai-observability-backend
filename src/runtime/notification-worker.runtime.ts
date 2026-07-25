import type { ConsumerChannel } from "../messaging/rabbitmq.consumer.js";
import type { NotificationWorker } from "../notifications/notification-worker.js";
import type { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "./reliable-queue-worker.runtime.js";

export class NotificationWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<NotificationWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: { mainExchange: string; prefetch: number },
    logger: WorkerLogger = console
  ) {
    super(
      channel,
      worker,
      failures,
      {
        queueName: "notification_queue",
        mainExchange: options.mainExchange,
        prefetch: options.prefetch,
        workerLabel: "Internal notification worker"
      },
      logger
    );
  }
}
