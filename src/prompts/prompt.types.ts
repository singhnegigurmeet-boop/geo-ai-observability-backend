import type { QueueName } from "../messaging/queue-names.js";
import type {
  EntityPathType,
  PromptType
} from "../types/database.types.js";

export type PromptPlanEntry = {
  promptType: PromptType;
  promptVersion: "v1" | "v1_light";
  queueName: QueueName;
};

export type PromptPlanPolicyContext = {
  actorType: "anonymous" | "user";
  userId: string | null;
  workspaceId: string | null;
  anonymousSessionId: string | null;
  pathLevel: EntityPathType;
};

export type PromptPlanningResult =
  | { outcome: "planned"; promptJobCount: number }
  | { outcome: "noop"; promptJobCount: 0 };
