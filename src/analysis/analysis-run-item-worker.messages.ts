import {
  parseAggregateIdMessage,
  type AggregateIdPayload
} from "../messaging/aggregate-id-message.js";
import type { QueueMessage } from "../messaging/queue-message.types.js";

export type AnalysisRunItemCreatedPayload =
  AggregateIdPayload<"analysisRunItemId">;
export type AnalysisRunItemCreatedMessage =
  QueueMessage<AnalysisRunItemCreatedPayload>;

export class InvalidAnalysisRunItemMessageError extends Error {
  readonly code = "INVALID_ANALYSIS_RUN_ITEM_MESSAGE";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidAnalysisRunItemMessageError";
  }
}

export function parseAnalysisRunItemCreatedMessage(
  input: unknown
): AnalysisRunItemCreatedMessage {
  return parseAggregateIdMessage(input, {
    eventType: "analysis_run_item.created",
    aggregateType: "analysis_run_item",
    idKey: "analysisRunItemId",
    invalid: (message) => new InvalidAnalysisRunItemMessageError(message)
  });
}
