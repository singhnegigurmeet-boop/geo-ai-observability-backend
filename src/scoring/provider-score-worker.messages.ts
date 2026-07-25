import {
  parseAggregateIdMessage,
  type AggregateIdPayload
} from "../messaging/aggregate-id-message.js";
import type { QueueMessage } from "../messaging/queue-message.types.js";

export type ProviderResultCreatedPayload =
  AggregateIdPayload<"providerResultId">;
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
  return parseAggregateIdMessage(input, {
    eventType: "provider_result.created",
    aggregateType: "provider_result",
    idKey: "providerResultId",
    invalid: (message) => new InvalidProviderResultMessageError(message)
  });
}
