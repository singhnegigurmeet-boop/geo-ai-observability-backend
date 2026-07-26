import {
  parseAggregateIdMessage,
  type AggregateIdPayload
} from "../../../utils/aggregate-id-message.js";
import type { QueueMessage } from "../../../common/messaging/queue-message.types.js";

export type ClassificationResultCreatedPayload =
  AggregateIdPayload<"providerResultId">;
export type ClassificationResultCreatedMessage =
  QueueMessage<ClassificationResultCreatedPayload>;

export function parseClassificationResultCreatedMessage(
  input: unknown
): ClassificationResultCreatedMessage {
  return parseAggregateIdMessage(input, {
    eventType: "domain_category_classification_result.created",
    aggregateType: "provider_result",
    idKey: "providerResultId",
    invalid: (message) => new InvalidClassificationResultMessageError(message)
  });
}

export class InvalidClassificationResultMessageError extends Error {
  readonly code = "INVALID_CLASSIFICATION_RESULT_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidClassificationResultMessageError";
  }
}
