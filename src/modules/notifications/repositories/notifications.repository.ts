import { BaseRepository } from "../../../repositories/base.repository.js";
import { SQL_QUERIES } from "../../../db/sql-queries.js";
import type { NotificationInput, NotificationRow } from "../../../types/database.types.js";

export class NotificationsRepository extends BaseRepository<NotificationRow> {
  async insertNotification(input: NotificationInput) {
    return this.executeSingleQueryOrThrow<NotificationRow>(
      SQL_QUERIES.notifications.insert,
      [input.domainId, input.analysisDiffId, input.channel, JSON.stringify(input.payload)],
      "Failed to insert notification"
    );
  }

  async findById(notificationId: number) {
    return this.executeSingleQuery<NotificationRow>(
      SQL_QUERIES.notifications.findById,
      [notificationId]
    );
  }

  async markSent(notificationId: number) {
    return this.executeSingleQueryOrThrow<NotificationRow>(
      SQL_QUERIES.notifications.markSent,
      [notificationId],
      "Failed to mark notification sent"
    );
  }

  async markFailed(notificationId: number, errorMessage: string) {
    return this.executeSingleQueryOrThrow<NotificationRow>(
      SQL_QUERIES.notifications.markFailed,
      [notificationId, errorMessage],
      "Failed to mark notification failed"
    );
  }
}

export const notificationsRepository = new NotificationsRepository();
