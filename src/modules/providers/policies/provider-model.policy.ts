import type { ProviderName } from "../../../common/types/database.types.js";

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

export type ProviderModelPair = {
  provider: ProviderName;
  model: string;
};

export type ProviderModelPolicyContext = {
  actorType: "anonymous" | "user";
  providerModels?: readonly ProviderModelPair[] | null;
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

export function validateFrozenProviderModel(
  pair: ProviderModelPair,
  realProvidersEnabled = false
): ProviderModelSelection {
  return validateProviderModelPair(pair, realProvidersEnabled);
}

function validateProviderModelPair(
  pair: ProviderModelPair,
  realProvidersEnabled = false
): ProviderModelSelection {
  const { provider, model } = pair;
  if (provider === "mock") {
    if (!isMockModel(model)) {
      throw new InvalidProviderModelSelectionError(
        `Unsupported mock model: ${model}`
      );
    }
    return { provider, model, queueName: "mock_queue" };
  }
  if (!realProvidersEnabled) {
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

export function resolveProviderModelSet(
  context: ProviderModelPolicyContext
): ProviderModelSelection[] {
  if (context.actorType === "anonymous") {
    if (context.providerModels !== undefined && context.providerModels !== null) {
      throw new InvalidProviderModelSelectionError(
        "Anonymous analysis cannot select providers or models"
      );
    }
    return [
      {
        provider: "mock",
        model: "mock-fast",
        queueName: "mock_queue"
      }
    ];
  }

  const requested =
    context.providerModels ??
    [{ provider: "mock" as const, model: "mock-standard" }];
  if (requested.length === 0 || requested.length > 4) {
    throw new InvalidProviderModelSelectionError(
      "providerModels must contain between 1 and 4 pairs"
    );
  }
  const normalized = new Map<string, ProviderModelSelection>();
  for (const pair of requested) {
    const selected = validateProviderModelPair(
      pair,
      context.realProvidersEnabled
    );
    normalized.set(`${selected.provider}\u0000${selected.model}`, selected);
  }
  return [...normalized.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.model.localeCompare(right.model)
  );
}

export function providerModelPairs(
  selections: readonly ProviderModelPair[]
): ProviderModelPair[] {
  return selections.map(({ provider, model }) => ({ provider, model }));
}

export function serializeProviderModelSet(
  providerModels: readonly ProviderModelPair[]
) {
  return JSON.stringify(providerModelPairs(providerModels));
}

export function sameProviderModelSet(
  left: readonly ProviderModelPair[],
  right: readonly ProviderModelPair[]
) {
  return serializeProviderModelSet(left) === serializeProviderModelSet(right);
}

export function parseProviderName(value: unknown): ProviderName | null {
  if (value === undefined || value === null) return null;
  if (
    value === "mock" ||
    value === "openai" ||
    value === "gemini" ||
    value === "claude"
  ) {
    return value;
  }
  throw new InvalidProviderModelSelectionError("Provider is invalid");
}

export function parseProviderModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.length > 0 && value.length <= 255) {
    return value;
  }
  throw new InvalidProviderModelSelectionError("Model is invalid");
}

export function parseProviderModels(
  value: unknown
): ProviderModelPair[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw new InvalidProviderModelSelectionError(
      "providerModels must contain between 1 and 4 pairs"
    );
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new InvalidProviderModelSelectionError(
        "providerModels contains an invalid pair"
      );
    }
    const pair = entry as Record<string, unknown>;
    const provider = parseProviderName(pair.provider);
    const model = parseProviderModel(pair.model);
    if (!provider || !model) {
      throw new InvalidProviderModelSelectionError(
        "providerModels pairs require provider and model"
      );
    }
    return { provider, model };
  });
}

export function isMockModel(value: string): value is MockModel {
  return (MOCK_MODELS as readonly string[]).includes(value);
}
