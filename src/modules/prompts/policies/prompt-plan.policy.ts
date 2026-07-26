import { promptQueueName } from "../../../common/messaging/queue-names.js";
import {
  applicablePromptTypes,
  promptTypePolicy
} from "./prompt-policy.registry.js";
import type {
  PromptPlanEntry,
  PromptPlanPolicyContext
} from "../types/prompt.types.js";

export function promptPlanFor(
  context: PromptPlanPolicyContext
): readonly PromptPlanEntry[] {
  return applicablePromptTypes(context.pathLevel).map((promptType) => {
    const policy = promptTypePolicy(promptType);
    return {
      promptType,
      promptDepth: context.promptDepth,
      businessPromptVersion: policy.businessPromptVersion,
      responseContractVersion: policy.responseContractVersion,
      queueName: promptQueueName(promptType)
    };
  });
}
