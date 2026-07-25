import {
  parseAggregateIdMessage,
  type AggregateIdPayload
} from "../../../utils/aggregate-id-message.js";

export type NotificationCreatedPayload = AggregateIdPayload<"notificationId">;

export class InvalidNotificationMessageError extends Error {
  readonly code = "INVALID_NOTIFICATION_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidNotificationMessageError";
  }
}

export function parseNotificationCreatedMessage(input: unknown) {
  return parseAggregateIdMessage(input, {
    eventType: "notification.created",
    aggregateType: "notification",
    idKey: "notificationId",
    invalid: (message) => new InvalidNotificationMessageError(message)
  });
}
