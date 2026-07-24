import type { JsonObject } from "../types/database.types.js";

export type QueueMessage<TPayload extends JsonObject = JsonObject> = {
  messageId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  attempt: number;
  payload: TPayload;
};
