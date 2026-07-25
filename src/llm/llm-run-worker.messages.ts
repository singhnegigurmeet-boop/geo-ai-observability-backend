import { z } from "zod";
import type { QueueMessage } from "../messaging/queue-message.types.js";
import type { JsonObject } from "../types/database.types.js";

const databaseId = z.string().regex(/^[1-9]\d*$/, "must be a positive database ID");

const payloadSchema = z
  .object({
    llmRunId: databaseId,
    analysisRunItemId: databaseId.optional(),
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
    eventType: z.literal("llm_run.created"),
    aggregateType: z.literal("llm_run"),
    aggregateId: databaseId,
    occurredAt: z.string().datetime({ offset: true }),
    attempt: z.number().int().positive(),
    payload: payloadSchema
  })
  .strict()
  .superRefine((message, context) => {
    if (message.aggregateId !== message.payload.llmRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aggregateId must match payload.llmRunId"
      });
    }
  });

export type LlmRunCreatedPayload = z.infer<typeof payloadSchema> & JsonObject;
export type LlmRunCreatedMessage = QueueMessage<LlmRunCreatedPayload>;

export class InvalidLlmRunMessageError extends Error {
  readonly code = "INVALID_LLM_RUN_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidLlmRunMessageError";
  }
}

export function parseLlmRunCreatedMessage(input: unknown): LlmRunCreatedMessage {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidLlmRunMessageError(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return parsed.data;
}
