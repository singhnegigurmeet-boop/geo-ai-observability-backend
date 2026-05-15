import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import { NOTIFICATION_QUEUE_NAME } from "../queue/notification.queue.js";
import { NotificationService } from "../modules/notifications/services/notification.service.js";
import type { NotificationJobData } from "../types/queue.types.js";

export function createNotificationWorker(notificationService: NotificationService) {
  const worker = new Worker<NotificationJobData>(
    NOTIFICATION_QUEUE_NAME,
    async (job) => {
      await notificationService.sendNotification(job.data.notificationId);
    },
    {
      connection: redisConnection,
      concurrency: 5
    }
  );

  worker.on("completed", (job) => {
    console.log(`Notification job completed: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Notification job failed: ${job?.id}`, error);
  });

  return worker;
}
