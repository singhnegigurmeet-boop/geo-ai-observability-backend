import type { DatabaseExecutor } from "../db/database-executor.js";
import type { NotificationRow } from "../types/database.types.js";

export class NotificationRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findForUpdate(notificationId: string) {
    const result = await this.database.query<NotificationRow>(
      `
        SELECT *
        FROM notifications
        WHERE notification_id = $1
        FOR UPDATE
      `,
      [notificationId]
    );
    return result.rows[0] ?? null;
  }

  async markInternalSent(notificationId: string) {
    const result = await this.database.query<NotificationRow>(
      `
        UPDATE notifications
        SET status = 'sent',
            sent_at = now(),
            attempt_count = attempt_count + 1,
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE notification_id = $1
          AND channel = 'internal'
          AND status IN ('pending', 'queued')
          AND attempt_count < 3
        RETURNING *
      `,
      [notificationId]
    );
    return result.rows[0] ?? null;
  }
}
