import type {
  PromptDepth,
  ProviderName
} from "../../../common/types/database.types.js";
import {
  MAX_ANALYSIS_PROVIDER_MODELS,
  classificationProfile,
  enabledAnalysisProfiles,
  providerModelProfile,
  type ProviderModelProfile
} from "../registry/provider-model.registry.js";

export type ProviderModelPair = {
  provider: ProviderName;
  model: string;
};

export type ProviderModelRequest =
  | ProviderModelPair
  | {
      provider: ProviderName;
      selection: "all";
    };

export type ProviderModelSelection = Pick<
  ProviderModelProfile,
  | "provider"
  | "model"
  | "queueName"
  | "modelProfileVersion"
  | "preferredStructuredOutputMode"
  | "providerInstructionProfile"
>;

export type ProviderModelPolicyContext = {
  actorType: "anonymous" | "user";
  providerModels?: readonly ProviderModelRequest[] | null;
  promptDepth?: PromptDepth;
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
  pair: ProviderModelPair & { modelProfileVersion?: string },
  realProvidersEnabled = false,
  promptDepth?: PromptDepth
): ProviderModelSelection {
  const profile = requireUsableProfile(
    pair.provider,
    pair.model,
    realProvidersEnabled
  );
  if (
    pair.modelProfileVersion !== undefined &&
    pair.modelProfileVersion !== profile.modelProfileVersion
  ) {
    throw new InvalidProviderModelSelectionError(
      `Frozen model profile version does not match ${pair.provider}/${pair.model}`
    );
  }
  assertDepthSupported(profile, promptDepth);
  return selection(profile);
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
    const anonymous = enabledAnalysisProfiles().find(
      (profile) => profile.anonymousEligible
    );
    if (!anonymous) {
      throw new InvalidProviderModelSelectionError(
        "No anonymous provider/model policy is enabled"
      );
    }
    assertDepthSupported(anonymous, context.promptDepth);
    return [selection(anonymous)];
  }

  const requested =
    context.providerModels ??
    [{ provider: "mock" as const, model: "mock-standard" }];
  if (requested.length === 0) {
    throw new InvalidProviderModelSelectionError(
      "providerModels must contain at least one selection"
    );
  }

  const expanded = requested.flatMap((entry) =>
    "selection" in entry
      ? enabledAnalysisProfiles(entry.provider).map((profile) => ({
          provider: profile.provider,
          model: profile.model
        }))
      : [entry]
  );
  const normalized = new Map<string, ProviderModelSelection>();
  for (const pair of expanded) {
    const profile = requireUsableProfile(
      pair.provider,
      pair.model,
      context.realProvidersEnabled ?? false
    );
    if (!profile.loggedInEligible) {
      throw new InvalidProviderModelSelectionError(
        `${pair.provider}/${pair.model} is not available to logged-in analysis`
      );
    }
    assertDepthSupported(profile, context.promptDepth);
    normalized.set(
      `${profile.provider}\u0000${profile.model}`,
      selection(profile)
    );
  }
  if (
    normalized.size === 0 ||
    normalized.size > MAX_ANALYSIS_PROVIDER_MODELS
  ) {
    throw new InvalidProviderModelSelectionError(
      `Resolved provider models must contain between 1 and ${MAX_ANALYSIS_PROVIDER_MODELS} exact pairs`
    );
  }
  return [...normalized.values()].sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.model.localeCompare(right.model)
  );
}

export function resolveClassificationModel(input: {
  provider: ProviderName;
  model: string;
  realProvidersEnabled: boolean;
}) {
  const profile = classificationProfile(input.provider, input.model);
  if (!profile) {
    throw new InvalidProviderModelSelectionError(
      `${input.provider}/${input.model} is not eligible for classification`
    );
  }
  if (profile.provider !== "mock" && !input.realProvidersEnabled) {
    throw new InvalidProviderModelSelectionError("Real providers are disabled");
  }
  return selection(profile);
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
): ProviderModelRequest[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidProviderModelSelectionError(
      "providerModels must contain at least one selection"
    );
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new InvalidProviderModelSelectionError(
        "providerModels contains an invalid selection"
      );
    }
    const candidate = entry as Record<string, unknown>;
    const provider = parseProviderName(candidate.provider);
    if (!provider) {
      throw new InvalidProviderModelSelectionError(
        "providerModels selections require provider"
      );
    }
    if (candidate.selection === "all") {
      return { provider, selection: "all" };
    }
    const model = parseProviderModel(candidate.model);
    if (!model) {
      throw new InvalidProviderModelSelectionError(
        "Exact providerModels selections require model"
      );
    }
    return { provider, model };
  });
}

export function isMockModel(value: string) {
  const profile = providerModelProfile("mock", value);
  return Boolean(profile?.enabled && profile.adapterSupported);
}

function requireUsableProfile(
  provider: ProviderName,
  model: string,
  realProvidersEnabled: boolean
) {
  const profile = providerModelProfile(provider, model);
  if (
    !profile ||
    !profile.enabled ||
    !profile.selectableForAnalysis ||
    !profile.adapterSupported
  ) {
    throw new InvalidProviderModelSelectionError(
      `Unsupported provider/model: ${provider}/${model}`
    );
  }
  if (provider !== "mock" && !realProvidersEnabled) {
    throw new InvalidProviderModelSelectionError("Real providers are disabled");
  }
  return profile;
}

function assertDepthSupported(
  profile: ProviderModelProfile,
  promptDepth?: PromptDepth
) {
  if (
    promptDepth !== undefined &&
    !profile.supportedPromptDepths.includes(promptDepth)
  ) {
    throw new InvalidProviderModelSelectionError(
      `${profile.provider}/${profile.model} does not support ${promptDepth} prompt depth`
    );
  }
}

function selection(profile: ProviderModelProfile): ProviderModelSelection {
  return {
    provider: profile.provider,
    model: profile.model,
    queueName: profile.queueName,
    modelProfileVersion: profile.modelProfileVersion,
    preferredStructuredOutputMode: profile.preferredStructuredOutputMode,
    providerInstructionProfile: profile.providerInstructionProfile
  };
}
