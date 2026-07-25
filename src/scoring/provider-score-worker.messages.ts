import { z } from "zod";
import type { QueueMessage } from "../messaging/queue-message.types.js";
import type { JsonObject } from "../types/database.types.js";

const databaseId = z.string().regex(/^[1-9]\d*$/, "must be a positive database ID");

const payloadSchema = z
  .object({
    providerResultId: databaseId,
    providerJobId: databaseId.optional(),
    promptJobId: databaseId.optional(),
    analysisRunId: databaseId.optional()
  })
  .strict();

const envelopeSchema = z
  .object({
    messageId: z.string().min(1),
    eventType: z.literal("provider_result.created"),
    aggregateType: z.literal("provider_result"),
    aggregateId: databaseId,
    occurredAt: z.string().datetime({ offset: true }),
    attempt: z.number().int().positive(),
    payload: payloadSchema
  })
  .strict()
  .superRefine((message, context) => {
    if (message.aggregateId !== message.payload.providerResultId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aggregateId must match payload.providerResultId"
      });
    }
  });

export type ProviderResultCreatedPayload = z.infer<typeof payloadSchema> &
  JsonObject;
export type ProviderResultCreatedMessage =
  QueueMessage<ProviderResultCreatedPayload>;

export class InvalidProviderResultMessageError extends Error {
  readonly code = "INVALID_PROVIDER_RESULT_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderResultMessageError";
  }
}

export function parseProviderResultCreatedMessage(
  input: unknown
): ProviderResultCreatedMessage {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidProviderResultMessageError(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return parsed.data;
}
