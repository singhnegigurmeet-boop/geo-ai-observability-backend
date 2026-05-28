import type { Queue } from "bullmq";
import type { NotificationsRepository } from "../repositories/notifications.repository.js";
import type { ObservabilityIndexService } from "../../observability/services/observability-index.service.js";
import type { AnalysisDiffRow } from "../../../types/database.types.js";
import type { NotificationJobData } from "../../../types/queue.types.js";

type NotificationServiceDependencies = {
  notificationsRepository: NotificationsRepository;
  notificationQueue: Queue<NotificationJobData>;
  observabilityIndexService: ObservabilityIndexService;
};

export class NotificationService {
  constructor(private readonly dependencies: NotificationServiceDependencies) {}

  async enqueueDiffNotifications(diffs: AnalysisDiffRow[]) {
    const jobs: Array<{ notificationId: number; diffId: number }> = [];

    for (const diff of diffs) {
      const notification = await this.dependencies.notificationsRepository.insertNotification({
        domainId: diff.domain_id,
        analysisDiffId: diff.id,
        channel: "log",
        payload: {
          diff_type: diff.diff_type,
          provider: diff.provider,
          severity: diff.severity,
          old_value: diff.old_value,
          new_value: diff.new_value,
          analysis_run_id: diff.analysis_run_id,
          previous_analysis_run_id: diff.previous_analysis_run_id
        }
      });

      await this.dependencies.notificationQueue.add("send-notification", {
        notificationId: notification.id
      });

      await this.dependencies.observabilityIndexService.indexNotification({
        event: "notification_queued",
        notification_id: notification.id,
        domain_id: notification.domain_id,
        analysis_diff_id: notification.analysis_diff_id,
        channel: notification.channel,
        status: notification.status,
        payload: notification.payload,
        error_message: notification.error_message,
        timestamp: notification.created_at.toISOString()
      });

      jobs.push({ notificationId: notification.id, diffId: diff.id });
    }

    return jobs;
  }

  async sendNotification(notificationId: number) {
    const notification = await this.dependencies.notificationsRepository.findById(notificationId);

    if (!notification) {
      throw new Error(`Notification not found: ${notificationId}`);
    }

    try {
      console.log("[Notification:log]", {
        notification_id: notification.id,
        domain_id: notification.domain_id,
        analysis_diff_id: notification.analysis_diff_id,
        payload: notification.payload
      });

      const sentNotification = await this.dependencies.notificationsRepository.markSent(notification.id);

      await this.dependencies.observabilityIndexService.indexNotification({
        event: "notification_sent",
        notification_id: sentNotification.id,
        domain_id: sentNotification.domain_id,
        analysis_diff_id: sentNotification.analysis_diff_id,
        channel: sentNotification.channel,
        status: sentNotification.status,
        payload: sentNotification.payload,
        error_message: sentNotification.error_message,
        timestamp: sentNotification.sent_at?.toISOString() ?? new Date().toISOString()
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown notification error";
      const failedNotification = await this.dependencies.notificationsRepository.markFailed(notification.id, errorMessage);
      await this.dependencies.observabilityIndexService.indexNotification({
        event: "notification_failed",
        notification_id: failedNotification.id,
        domain_id: failedNotification.domain_id,
        analysis_diff_id: failedNotification.analysis_diff_id,
        channel: failedNotification.channel,
        status: failedNotification.status,
        payload: failedNotification.payload,
        error_message: failedNotification.error_message,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }
}
