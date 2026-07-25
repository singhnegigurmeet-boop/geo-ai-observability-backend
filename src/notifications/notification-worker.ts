import type { NotificationService } from "./notification.service.js";
import { parseNotificationCreatedMessage } from "./notification-worker.messages.js";

export class NotificationWorker {
  constructor(
    private readonly notifications: Pick<NotificationService, "deliverInternal">
  ) {}

  process(input: unknown) {
    const message = parseNotificationCreatedMessage(input);
    return this.notifications.deliverInternal(message.payload);
  }
}
