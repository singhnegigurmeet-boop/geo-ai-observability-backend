import {
  parseAggregateIdMessage,
  type AggregateIdPayload
} from "../messaging/aggregate-id-message.js";
import type { QueueMessage } from "../messaging/queue-message.types.js";

export type AnalysisRunCreatedPayload = AggregateIdPayload<"analysisRunId">;
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
  return parseAggregateIdMessage(input, {
    eventType: "analysis_run.created",
    aggregateType: "analysis_run",
    idKey: "analysisRunId",
    invalid: (message) => new InvalidAnalysisRunMessageError(message)
  });
}
