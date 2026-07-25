import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { NotificationRepository } from "./notification.repository.js";
import type { NotificationCreatedPayload } from "./notification-worker.messages.js";

type NotificationDatabase = DatabaseExecutor & TransactionPool;

export class NotificationDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly permanent = false
  ) {
    super(message);
    this.name = "NotificationDeliveryError";
  }
}

export class NotificationService {
  constructor(private readonly database: NotificationDatabase) {}

  async deliverInternal(payload: NotificationCreatedPayload) {
    return inTransaction(this.database, async (client) => {
      const notifications = new NotificationRepository(client);
      const notification = await notifications.findForUpdate(
        payload.notificationId
      );
      if (!notification) {
        throw new NotificationDeliveryError(
          "NOTIFICATION_NOT_FOUND",
          "Notification does not exist",
          true
        );
      }
      if (notification.status === "sent") {
        return { outcome: "noop" as const, notificationId: notification.notification_id };
      }
      if (
        notification.analysis_run_id !== payload.analysisRunId ||
        notification.failure_record_id !== payload.failureRecordId ||
        notification.is_admin_notification !== payload.isAdmin
      ) {
        throw new NotificationDeliveryError(
          "NOTIFICATION_MESSAGE_MISMATCH",
          "Notification message does not match authoritative state",
          true
        );
      }
      if (notification.channel !== "internal") {
        throw new NotificationDeliveryError(
          "EXTERNAL_NOTIFICATION_UNSUPPORTED",
          "Phase 12 delivers internal notifications only",
          true
        );
      }
      const sent = await notifications.markInternalSent(
        notification.notification_id
      );
      if (!sent) {
        throw new NotificationDeliveryError(
          "NOTIFICATION_TRANSITION_FAILED",
          "Notification could not transition to sent"
        );
      }
      return { outcome: "sent" as const, notificationId: sent.notification_id };
    });
  }
}
