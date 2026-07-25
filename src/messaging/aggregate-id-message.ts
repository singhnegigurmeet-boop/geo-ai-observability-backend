import { z } from "zod";
import type { JsonObject } from "../types/database.types.js";
import type { QueueMessage } from "./queue-message.types.js";

const databaseId = z.string().regex(/^[1-9]\d*$/, "must be a positive database ID");

export type AggregateIdPayload<TKey extends string> = {
  [Key in TKey]: string;
} & JsonObject;

export function parseAggregateIdMessage<
  TEventType extends string,
  TAggregateType extends string,
  TIdKey extends string
>(
  input: unknown,
  contract: {
    eventType: TEventType;
    aggregateType: TAggregateType;
    idKey: TIdKey;
    invalid: (message: string) => Error;
  }
): QueueMessage<AggregateIdPayload<TIdKey>> {
  const payloadSchema = z
    .object({ [contract.idKey]: databaseId })
    .strict();
  const envelopeSchema = z
    .object({
      messageId: z.string().min(1),
      eventType: z.literal(contract.eventType),
      aggregateType: z.literal(contract.aggregateType),
      aggregateId: databaseId,
      occurredAt: z.string().datetime({ offset: true }),
      attempt: z.number().int().positive(),
      payload: payloadSchema
    })
    .strict()
    .superRefine((message, context) => {
      if (message.aggregateId !== message.payload[contract.idKey]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `aggregateId must match payload.${contract.idKey}`
        });
      }
    });
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw contract.invalid(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return parsed.data as unknown as QueueMessage<AggregateIdPayload<TIdKey>>;
}
