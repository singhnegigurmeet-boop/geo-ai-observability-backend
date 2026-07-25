import type { ProviderName } from "../types/database.types.js";

export const MOCK_MODELS = [
  "mock-fast",
  "mock-standard",
  "mock-quality"
] as const;

export type MockModel = (typeof MOCK_MODELS)[number];

export type ProviderModelSelection = {
  provider: "mock";
  model: MockModel;
  queueName: "mock_queue";
};

export type ProviderModelPolicyContext = {
  actorType: "anonymous" | "user";
  requestedProvider: ProviderName | null;
  requestedModel: string | null;
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
  if (provider !== "mock") {
    throw new InvalidProviderModelSelectionError(
      "Only the mock provider is allowed in Phase 8"
    );
  }
  if (!isMockModel(model)) {
    throw new InvalidProviderModelSelectionError(
      `Unsupported mock model: ${model}`
    );
  }
  return { provider, model, queueName: "mock_queue" };
}

export function isMockModel(value: string): value is MockModel {
  return (MOCK_MODELS as readonly string[]).includes(value);
}
