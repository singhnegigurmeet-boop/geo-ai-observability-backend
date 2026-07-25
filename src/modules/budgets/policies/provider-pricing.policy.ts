import type { ProviderName } from "../../../common/types/database.types.js";

const mockMicrosPerHundredTokens: Record<string, number> = {
  "mock-fast": 1,
  "mock-standard": 2,
  "mock-quality": 3
};

const realMicrosPerMillionTokens: Record<
  Exclude<ProviderName, "mock">,
  Record<string, { input: number; output: number }>
> = {
  openai: {
    "gpt-4o-mini": { input: 150_000, output: 600_000 }
  },
  gemini: {
    "gemini-1.5-flash": { input: 75_000, output: 300_000 }
  },
  claude: {
    "claude-3-5-sonnet": { input: 3_000_000, output: 15_000_000 }
  }
};

export function estimateCostMicros(input: {
  provider: ProviderName;
  model: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}) {
  if (input.provider === "mock") {
    const rate = mockMicrosPerHundredTokens[input.model];
    if (rate === undefined) {
      throw new Error(`No mock pricing policy exists for ${input.model}`);
    }
    const totalTokens =
      input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
    return Math.ceil((totalTokens * rate) / 100);
  }
  const rate = realMicrosPerMillionTokens[input.provider][input.model];
  if (!rate) {
    throw new Error(
      `No local pricing policy exists for ${input.provider}/${input.model}`
    );
  }
  return Math.ceil(
    (((input.inputTokens ?? 0) * rate.input) +
      ((input.outputTokens ?? 0) * rate.output)) /
      1_000_000
  );
}
