import {
  parseAggregateIdMessage,
  type AggregateIdPayload
} from "../../../utils/aggregate-id-message.js";
import type { QueueMessage } from "../../../common/messaging/queue-message.types.js";

export type ClassificationJobCreatedPayload =
  AggregateIdPayload<"classificationJobId">;
export type ClassificationJobCreatedMessage =
  QueueMessage<ClassificationJobCreatedPayload>;

export function parseClassificationJobCreatedMessage(
  input: unknown
): ClassificationJobCreatedMessage {
  return parseAggregateIdMessage(input, {
    eventType: "domain_category_classification.created",
    aggregateType: "domain_category_classification",
    idKey: "classificationJobId",
    invalid: (message) => new InvalidClassificationMessageError(message)
  });
}

export class InvalidClassificationMessageError extends Error {
  readonly code = "INVALID_CLASSIFICATION_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidClassificationMessageError";
  }
}
