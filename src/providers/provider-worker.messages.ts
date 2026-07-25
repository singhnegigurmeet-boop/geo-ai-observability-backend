import { z } from "zod";
import type { QueueMessage } from "../messaging/queue-message.types.js";
import type { JsonObject } from "../types/database.types.js";

const databaseId = z.string().regex(/^[1-9]\d*$/, "must be a positive database ID");

const payloadSchema = z
  .object({
    providerJobId: databaseId,
    promptJobId: databaseId,
    provider: z.enum(["mock", "openai", "gemini", "claude"]),
    model: z.enum([
      "mock-fast",
      "mock-standard",
      "mock-quality",
      "gpt-4o-mini",
      "gemini-1.5-flash",
      "claude-3-5-sonnet"
    ])
  })
  .strict();

const allowedModels = {
  mock: new Set(["mock-fast", "mock-standard", "mock-quality"]),
  openai: new Set(["gpt-4o-mini"]),
  gemini: new Set(["gemini-1.5-flash"]),
  claude: new Set(["claude-3-5-sonnet"])
} as const;

const envelopeSchema = z
  .object({
    messageId: z.string().min(1),
    eventType: z.literal("provider_job.created"),
    aggregateType: z.literal("provider_job"),
    aggregateId: databaseId,
    occurredAt: z.string().datetime({ offset: true }),
    attempt: z.number().int().positive(),
    payload: payloadSchema
  })
  .strict()
  .superRefine((message, context) => {
    if (message.aggregateId !== message.payload.providerJobId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aggregateId must match payload.providerJobId"
      });
    }
    if (!allowedModels[message.payload.provider].has(message.payload.model)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider and model do not form an allowed pair"
      });
    }
  });

export type ProviderJobCreatedPayload = z.infer<typeof payloadSchema> &
  JsonObject;
export type ProviderJobCreatedMessage =
  QueueMessage<ProviderJobCreatedPayload>;

export class InvalidProviderJobMessageError extends Error {
  readonly code = "INVALID_PROVIDER_JOB_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderJobMessageError";
  }
}

export function parseProviderJobCreatedMessage(
  input: unknown
): ProviderJobCreatedMessage {
  const parsed = envelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidProviderJobMessageError(
      parsed.error.issues.map((issue) => issue.message).join("; ")
    );
  }
  return parsed.data;
}
