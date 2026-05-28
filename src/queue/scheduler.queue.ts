import { Queue } from "bullmq";
import { env } from "../config/env.js";
import { redisConnection } from "../lib/redis.js";
import type { SchedulerJobData } from "../types/queue.types.js";

export const SCHEDULER_QUEUE_NAME = "v6-scheduler";

export const schedulerQueue = new Queue<SchedulerJobData>(SCHEDULER_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100, age: 86400 },
    removeOnFail: { count: 500, age: 604800 }
  }
});

export async function ensureV6SchedulerRepeatableJob() {
  await schedulerQueue.add(
    "v6-scheduler-placeholder",
    { triggeredAt: new Date().toISOString() },
    {
      jobId: "v6-scheduler-placeholder-tick",
      repeat: {
        every: env.SCHEDULER_TICK_MS
      }
    }
  );
}
