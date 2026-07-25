import {
  parseAggregateIdMessage,
  type AggregateIdPayload
} from "../messaging/aggregate-id-message.js";
import type { QueueMessage } from "../messaging/queue-message.types.js";

export type ProviderJobCreatedPayload = AggregateIdPayload<"providerJobId">;
export type ProviderJobCreatedMessage = QueueMessage<ProviderJobCreatedPayload>;

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
  return parseAggregateIdMessage(input, {
    eventType: "provider_job.created",
    aggregateType: "provider_job",
    idKey: "providerJobId",
    invalid: (message) => new InvalidProviderJobMessageError(message)
  });
}
