import type { ConsumerChannel } from "../messaging/rabbitmq.consumer.js";
import type { MockProviderWorker } from "../providers/mock-provider-worker.js";
import type { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import {
  ReliableQueueWorkerRuntime,
  type WorkerLogger
} from "./reliable-queue-worker.runtime.js";

export type MockProviderWorkerRuntimeOptions = {
  mainExchange: string;
  prefetch: number;
};

export class MockProviderWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(
    channel: ConsumerChannel,
    worker: Pick<MockProviderWorker, "process">,
    failures: Pick<FailureRecordRepository, "createOrReuse">,
    options: MockProviderWorkerRuntimeOptions,
    logger: WorkerLogger = console
  ) {
    super(
      channel,
      worker,
      failures,
      {
        queueName: "mock_queue",
        mainExchange: options.mainExchange,
        prefetch: options.prefetch,
        workerLabel: "Mock provider worker"
      },
      logger
    );
  }
}
