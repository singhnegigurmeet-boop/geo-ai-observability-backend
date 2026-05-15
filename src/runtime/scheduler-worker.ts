import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import { SCHEDULER_QUEUE_NAME } from "../queue/scheduler.queue.js";
import { DomainSchedulerService } from "../modules/scheduler/services/domain-scheduler.service.js";
import type { SchedulerJobData } from "../types/queue.types.js";

export function createSchedulerWorker(schedulerService: DomainSchedulerService) {
  const worker = new Worker<SchedulerJobData>(
    SCHEDULER_QUEUE_NAME,
    async () => {
      await schedulerService.enqueueDueDomains();
    },
    {
      connection: redisConnection,
      concurrency: 1
    }
  );

  worker.on("completed", (job) => {
    console.log(`Scheduler job completed: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Scheduler job failed: ${job?.id}`, error);
  });

  return worker;
}
