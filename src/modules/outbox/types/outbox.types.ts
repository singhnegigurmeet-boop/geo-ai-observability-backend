import type {
  JsonObject,
  OutboxEventRow
} from "../../../common/types/database.types.js";
import type { QueueName } from "../../../common/messaging/queue-names.js";

export type ClaimedOutboxEvent = OutboxEventRow & {
  payload: JsonObject;
  headers: JsonObject;
};

export type OutboxClaimOptions = {
  dispatcherId: string;
  batchSize: number;
  lockTimeoutMs: number;
  now: Date;
};

export type OutboxFailure = {
  outboxEventId: string;
  dispatcherId: string;
  errorCode: string;
  errorMessage: string;
  availableAt: Date;
  now: Date;
};

export type OutboxRoute = {
  queueName: QueueName;
};
