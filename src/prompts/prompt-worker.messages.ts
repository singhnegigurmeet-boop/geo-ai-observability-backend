import {
  parseAggregateIdMessage,
  type AggregateIdPayload
} from "../messaging/aggregate-id-message.js";
import type { QueueMessage } from "../messaging/queue-message.types.js";

export type PromptJobCreatedPayload = AggregateIdPayload<"promptJobId">;
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
  return parseAggregateIdMessage(input, {
    eventType: "prompt_job.created",
    aggregateType: "prompt_job",
    idKey: "promptJobId",
    invalid: (message) => new InvalidPromptJobMessageError(message)
  });
}
