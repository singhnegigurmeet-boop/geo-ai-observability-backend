import { parseAggregateIdMessage, type AggregateIdPayload } from "../../../utils/aggregate-id-message.js";
import type { QueueMessage } from "../../../common/messaging/queue-message.types.js";

export type HierarchyDiscoveryPayload = AggregateIdPayload<"preAnalysisRequestId">;
export type HierarchyDiscoveryMessage = QueueMessage<HierarchyDiscoveryPayload>;

export function parseHierarchyDiscoveryMessage(input: unknown): HierarchyDiscoveryMessage {
  for (const eventType of ["pre_analysis_request.accepted", "pre_analysis_request.discovery_progress"] as const) {
    try {
      return parseAggregateIdMessage(input, {
        eventType,
        aggregateType: "pre_analysis_request",
        idKey: "preAnalysisRequestId",
        invalid: (message) => new InvalidHierarchyDiscoveryMessageError(message)
      });
    } catch (error) {
      if (!(error instanceof InvalidHierarchyDiscoveryMessageError)) throw error;
    }
  }
  throw new InvalidHierarchyDiscoveryMessageError("Message does not match a hierarchy discovery event contract");
}

export class InvalidHierarchyDiscoveryMessageError extends Error {
  readonly code = "INVALID_HIERARCHY_DISCOVERY_MESSAGE";
  readonly permanent = true;
  constructor(message: string) { super(message); this.name = "InvalidHierarchyDiscoveryMessageError"; }
}
