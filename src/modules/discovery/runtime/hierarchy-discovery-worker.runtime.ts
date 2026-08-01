import type { ConsumerChannel } from "../../../common/messaging/rabbitmq.consumer.js";
import type { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import { ReliableQueueWorkerRuntime, type WorkerLogger } from "../../providers/runtime/reliable-queue-worker.runtime.js";
import type { HierarchyDiscoveryWorker } from "../workers/hierarchy-discovery.worker.js";

export class HierarchyDiscoveryWorkerRuntime extends ReliableQueueWorkerRuntime {
  constructor(channel:ConsumerChannel,worker:Pick<HierarchyDiscoveryWorker,"process">,failures:Pick<FailureRecordRepository,"createOrReuse">,options:{mainExchange:string;prefetch:number},logger:WorkerLogger=console){
    super(channel,worker,failures,{queueName:"domain_hierarchy_discovery_queue",mainExchange:options.mainExchange,prefetch:options.prefetch,workerLabel:"Hierarchy discovery worker"},logger);
  }
}
