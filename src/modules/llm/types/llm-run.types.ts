export type LlmRunCreationResult =
  | { outcome: "created"; llmRunId: string }
  | { outcome: "noop"; llmRunId: null };
