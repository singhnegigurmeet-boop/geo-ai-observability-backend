import { z } from "zod";
import type { QueueMessage } from "../messaging/queue-message.types.js";
import type { JsonObject } from "../types/database.types.js";

const databaseId = z.string().regex(/^[1-9]\d*$/);
const payloadSchema = z
  .object({
    notificationId: databaseId,
    analysisRunId: databaseId.nullable(),
    failureRecordId: databaseId.nullable(),
    isAdmin: z.boolean()
  })
  .strict();
const envelopeSchema = z
  .object({
    messageId: z.string().min(1),
    eventType: z.literal("notification.created"),
    aggregateType: z.literal("notification"),
    aggregateId: databaseId,
    occurredAt: z.string().datetime({ offset: true }),
    attempt: z.number().int().positive(),
    payload: payloadSchema
  })
  .strict()
  .superRefine((message, context) => {
    if (message.aggregateId !== message.payload.notificationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aggregateId must match notificationId"
      });
    }
  });

export type NotificationCreatedPayload = z.infer<typeof payloadSchema> &
  JsonObject;
export type NotificationCreatedMessage =
  QueueMessage<NotificationCreatedPayload>;

export class InvalidNotificationMessageError extends Error {
  readonly code = "INVALID_NOTIFICATION_MESSAGE";
  readonly permanent = true;
}

export function parseNotificationCreatedMessage(input: unknown) {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidNotificationMessageError(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return parsed.data;
}
