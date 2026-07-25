import type { ProviderName } from "../types/database.types.js";

export const MOCK_MODELS = [
  "mock-fast",
  "mock-standard",
  "mock-quality"
] as const;

export const REAL_PROVIDER_MODELS = {
  openai: "gpt-4o-mini",
  gemini: "gemini-1.5-flash",
  claude: "claude-3-5-sonnet"
} as const;

export type MockModel = (typeof MOCK_MODELS)[number];

export type ProviderModelSelection = {
  provider: ProviderName;
  model: string;
  queueName:
    | "mock_queue"
    | "openai_queue"
    | "gemini_queue"
    | "claude_queue";
};

export type ProviderModelPolicyContext = {
  actorType: "anonymous" | "user";
  requestedProvider: ProviderName | null;
  requestedModel: string | null;
  realProvidersEnabled?: boolean;
};

export class InvalidProviderModelSelectionError extends Error {
  readonly code = "INVALID_PROVIDER_MODEL_SELECTION";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidProviderModelSelectionError";
  }
}

export function selectProviderModel(
  context: ProviderModelPolicyContext
): ProviderModelSelection {
  if (context.actorType === "anonymous") {
    if (context.requestedProvider !== null || context.requestedModel !== null) {
      throw new InvalidProviderModelSelectionError(
        "Anonymous analysis cannot select a provider or model"
      );
    }
    return {
      provider: "mock",
      model: "mock-fast",
      queueName: "mock_queue"
    };
  }

  const provider = context.requestedProvider ?? "mock";
  const model = context.requestedModel ?? "mock-standard";
  if (provider === "mock") {
    if (!isMockModel(model)) {
      throw new InvalidProviderModelSelectionError(
        `Unsupported mock model: ${model}`
      );
    }
    return { provider, model, queueName: "mock_queue" };
  }
  if (!context.realProvidersEnabled) {
    throw new InvalidProviderModelSelectionError(
      "Real providers are disabled"
    );
  }
  if (REAL_PROVIDER_MODELS[provider] !== model) {
    throw new InvalidProviderModelSelectionError(
      `Unsupported ${provider} model: ${model}`
    );
  }
  return {
    provider,
    model,
    queueName: `${provider}_queue`
  };
}

export function isMockModel(value: string): value is MockModel {
  return (MOCK_MODELS as readonly string[]).includes(value);
}
