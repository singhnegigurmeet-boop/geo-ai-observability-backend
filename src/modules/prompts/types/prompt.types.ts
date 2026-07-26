import type { QueueName } from "../../../common/messaging/queue-names.js";
import type {
  EntityPathType,
  PromptDepth,
  PromptType
} from "../../../common/types/database.types.js";

export type PromptPlanEntry = {
  promptType: PromptType;
  promptDepth: PromptDepth;
  businessPromptVersion: string;
  responseContractVersion: string;
  queueName: QueueName;
};

export type PromptPlanPolicyContext = {
  pathLevel: EntityPathType;
  promptDepth: PromptDepth;
};

export type PromptPlanningResult =
  | { outcome: "planned"; promptJobCount: number }
  | { outcome: "noop"; promptJobCount: 0 };
