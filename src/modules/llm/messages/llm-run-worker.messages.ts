import {
  parseAggregateIdMessage,
  type AggregateIdPayload
} from "../../../utils/aggregate-id-message.js";
import type { QueueMessage } from "../../../common/messaging/queue-message.types.js";

export type LlmRunCreatedPayload = AggregateIdPayload<"llmRunId">;
export type LlmRunCreatedMessage = QueueMessage<LlmRunCreatedPayload>;

export class InvalidLlmRunMessageError extends Error {
  readonly code = "INVALID_LLM_RUN_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidLlmRunMessageError";
  }
}

export function parseLlmRunCreatedMessage(
  input: unknown
): LlmRunCreatedMessage {
  return parseAggregateIdMessage(input, {
    eventType: "llm_run.created",
    aggregateType: "llm_run",
    idKey: "llmRunId",
    invalid: (message) => new InvalidLlmRunMessageError(message)
  });
}
