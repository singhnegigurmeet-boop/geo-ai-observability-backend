import type { QueueName } from "../messaging/queue-names.js";
import type { PromptType } from "../types/database.types.js";

export type PromptPlanEntry = {
  promptType: PromptType;
  promptVersion: "v1";
  queueName: QueueName;
};

export type PromptPlanningResult =
  | { outcome: "planned"; promptJobCount: number }
  | { outcome: "noop"; promptJobCount: 0 };
