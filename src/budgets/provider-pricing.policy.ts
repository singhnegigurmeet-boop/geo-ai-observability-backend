import type { ProviderName } from "../types/database.types.js";

const mockMicrosPerHundredTokens: Record<string, number> = {
  "mock-fast": 1,
  "mock-standard": 2,
  "mock-quality": 3
};

export function estimateCostMicros(input: {
  provider: ProviderName;
  model: string;
  totalTokens: number;
}) {
  if (input.provider === "mock") {
    const rate = mockMicrosPerHundredTokens[input.model];
    if (rate === undefined) {
      throw new Error(`No mock pricing policy exists for ${input.model}`);
    }
    return Math.ceil((input.totalTokens * rate) / 100);
  }
  throw new Error(
    `Phase 10 has no pricing policy for provider ${input.provider}`
  );
}
