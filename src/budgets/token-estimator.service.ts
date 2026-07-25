import type {
  PromptType,
  ProviderName
} from "../types/database.types.js";
import { estimateCostMicros } from "./provider-pricing.policy.js";
import type { UsageEstimate } from "./budget.types.js";

const outputTokensByPrompt: Record<PromptType, number> = {
  visibility: 48,
  competitor: 64,
  ranking: 48,
  price_range: 64,
  pros_cons: 72
};

const modelOutputMultiplier: Record<string, number> = {
  "mock-fast": 0.75,
  "mock-standard": 1,
  "mock-quality": 1.25
};

export class TokenEstimatorService {
  estimate(input: {
    provider: ProviderName;
    model: string;
    promptText: string;
    promptType: PromptType;
    promptVersion: string;
  }): UsageEstimate {
    if (!input.promptText.trim()) {
      throw new Error("Cannot estimate tokens for a blank prompt");
    }
    const multiplier = modelOutputMultiplier[input.model];
    if (input.provider !== "mock" || multiplier === undefined) {
      throw new Error(
        `Phase 10 cannot estimate ${input.provider}/${input.model}`
      );
    }
    const inputTokens = Math.max(1, Math.ceil(input.promptText.length / 4));
    const versionMultiplier = input.promptVersion === "v1_light" ? 0.75 : 1;
    const outputTokens = Math.max(
      32,
      Math.ceil(
        outputTokensByPrompt[input.promptType] *
          multiplier *
          versionMultiplier
      )
    );
    const totalTokens = inputTokens + outputTokens;
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      costMicros: estimateCostMicros({
        provider: input.provider,
        model: input.model,
        totalTokens
      })
    };
  }
}
