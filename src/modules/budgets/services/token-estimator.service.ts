import type {
  PromptDepth,
  PromptType,
  ProviderName
} from "../../../common/types/database.types.js";
import { providerModelProfile } from "../../providers/registry/provider-model.registry.js";
import { estimateCostMicros } from "../policies/provider-pricing.policy.js";
import type { UsageEstimate } from "../types/budget.types.js";

type ExecutablePromptType =
  | PromptType
  | `hierarchy_discovery_${"category" | "brand" | "product" | "use_context"}`;

export class TokenEstimatorService {
  estimate(input: {
    provider: ProviderName;
    model: string;
    promptText: string;
    promptType: ExecutablePromptType;
    promptDepth: PromptDepth;
  }): UsageEstimate {
    if (!input.promptText.trim()) {
      throw new Error("Cannot estimate tokens for a blank prompt");
    }
    const profile = providerModelProfile(input.provider, input.model);
    if (!profile) {
      throw new Error(`Cannot estimate ${input.provider}/${input.model}`);
    }
    const inputTokens = Math.max(1, Math.ceil(input.promptText.length / 4));
    const outputTokens = profile.maximumOutputTokens[input.promptDepth];
    const totalTokens = inputTokens + outputTokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      costMicros: estimateCostMicros({
        provider: input.provider,
        model: input.model,
        totalTokens,
        inputTokens,
        outputTokens
      })
    };
  }
}
