import { z } from "zod";
import type { QueueMessage } from "../messaging/queue-message.types.js";
import type { JsonObject } from "../types/database.types.js";

const databaseId = z.string().regex(/^[1-9]\d*$/, "must be a positive database ID");

const payloadSchema = z
  .object({
    promptJobId: databaseId,
    llmRunId: databaseId.optional(),
    analysisRunItemId: databaseId.optional(),
    analysisRunId: databaseId.optional(),
    entityPathId: databaseId.optional(),
    startingEntityPathId: databaseId.optional(),
    promptType: z.enum([
      "competitor",
      "ranking",
      "visibility",
      "price_range",
      "pros_cons"
    ]).optional(),
    promptVersion: z.string().min(1).optional(),
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
    eventType: z.literal("prompt_job.created"),
    aggregateType: z.literal("prompt_job"),
    aggregateId: databaseId,
    occurredAt: z.string().datetime({ offset: true }),
    attempt: z.number().int().positive(),
    payload: payloadSchema
  })
  .strict()
  .superRefine((message, context) => {
    if (message.aggregateId !== message.payload.promptJobId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aggregateId must match payload.promptJobId"
      });
    }
  });

export type PromptJobCreatedPayload = z.infer<typeof payloadSchema> & JsonObject;
export type PromptJobCreatedMessage = QueueMessage<PromptJobCreatedPayload>;

export class InvalidPromptJobMessageError extends Error {
  readonly code = "INVALID_PROMPT_JOB_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidPromptJobMessageError";
  }
}

export function parsePromptJobCreatedMessage(
  input: unknown
): PromptJobCreatedMessage {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidPromptJobMessageError(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return parsed.data;
}
