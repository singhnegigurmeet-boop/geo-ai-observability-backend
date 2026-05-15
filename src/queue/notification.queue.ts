import { Queue } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import type { NotificationJobData } from "../types/queue.types.js";

export const NOTIFICATION_QUEUE_NAME = "analysis-notifications";

export const notificationQueue = new Queue<NotificationJobData>(NOTIFICATION_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000
    },
    removeOnComplete: { count: 1000, age: 86400 },
    removeOnFail: { count: 5000, age: 604800 }
  }
});
