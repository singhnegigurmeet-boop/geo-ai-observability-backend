import { z } from "zod";
import type { QueueMessage } from "../messaging/queue-message.types.js";
import type { JsonObject } from "../types/database.types.js";

const databaseId = z.string().regex(/^[1-9]\d*$/, "must be a positive database ID");

const payloadSchema = z
  .object({
    analysisRunItemId: databaseId,
    analysisRunId: databaseId.optional(),
    entityPathId: databaseId.optional(),
    startingEntityPathId: databaseId.optional(),
    actorType: z.enum(["anonymous", "user"]).optional(),
    userId: databaseId.nullable().optional(),
    workspaceId: databaseId.nullable().optional(),
    anonymousSessionId: databaseId.nullable().optional()
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.actorType === undefined) return;
    const validAnonymous =
      payload.actorType === "anonymous" &&
      payload.anonymousSessionId !== null &&
      payload.userId === null &&
      payload.workspaceId === null;
    const validUser =
      payload.actorType === "user" &&
      payload.userId !== null &&
      payload.workspaceId !== null;
    if (!validAnonymous && !validUser) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actor ownership fields are inconsistent"
      });
    }
  });

const envelopeSchema = z
  .object({
    messageId: z.string().min(1),
    eventType: z.literal("analysis_run_item.created"),
    aggregateType: z.literal("analysis_run_item"),
    aggregateId: databaseId,
    occurredAt: z.string().datetime({ offset: true }),
    attempt: z.number().int().positive(),
    payload: payloadSchema
  })
  .strict()
  .superRefine((message, context) => {
    if (message.aggregateId !== message.payload.analysisRunItemId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aggregateId must match payload.analysisRunItemId"
      });
    }
  });

export type AnalysisRunItemCreatedPayload = z.infer<typeof payloadSchema> &
  JsonObject;
export type AnalysisRunItemCreatedMessage =
  QueueMessage<AnalysisRunItemCreatedPayload>;

export class InvalidAnalysisRunItemMessageError extends Error {
  readonly code = "INVALID_ANALYSIS_RUN_ITEM_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidAnalysisRunItemMessageError";
  }
}

export function parseAnalysisRunItemCreatedMessage(
  input: unknown
): AnalysisRunItemCreatedMessage {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidAnalysisRunItemMessageError(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return parsed.data;
}
