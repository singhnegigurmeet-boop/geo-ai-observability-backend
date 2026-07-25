import { z } from "zod";
import type { QueueMessage } from "../messaging/queue-message.types.js";
import type { JsonObject } from "../types/database.types.js";

const databaseId = z.string().regex(/^[1-9]\d*$/, "must be a positive database ID");

const ownershipPayload = z
  .object({
    analysisRunId: databaseId,
    startingEntityPathId: databaseId,
    actorType: z.enum(["anonymous", "user"]),
    userId: databaseId.nullable(),
    workspaceId: databaseId.nullable(),
    anonymousSessionId: databaseId.nullable()
  })
  .strict()
  .superRefine((payload, context) => {
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

const analysisRunCreatedEnvelope = z
  .object({
    messageId: z.string().min(1),
    eventType: z.literal("analysis_run.created"),
    aggregateType: z.literal("analysis_run"),
    aggregateId: databaseId,
    occurredAt: z.string().datetime({ offset: true }),
    attempt: z.number().int().positive(),
    payload: ownershipPayload
  })
  .strict()
  .superRefine((message, context) => {
    if (message.aggregateId !== message.payload.analysisRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aggregateId must match payload.analysisRunId"
      });
    }
  });

export type AnalysisRunCreatedPayload = z.infer<typeof ownershipPayload> &
  JsonObject;
export type AnalysisRunCreatedMessage = QueueMessage<AnalysisRunCreatedPayload>;

export class InvalidAnalysisRunMessageError extends Error {
  readonly code = "INVALID_ANALYSIS_RUN_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidAnalysisRunMessageError";
  }
}

export function parseAnalysisRunCreatedMessage(
  input: unknown
): AnalysisRunCreatedMessage {
  const parsed = analysisRunCreatedEnvelope.safeParse(input);
  if (!parsed.success) {
    throw new InvalidAnalysisRunMessageError(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return parsed.data;
}
