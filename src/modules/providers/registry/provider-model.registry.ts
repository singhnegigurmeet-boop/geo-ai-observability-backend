import type {
  PromptDepth,
  ProviderName
} from "../../../common/types/database.types.js";

export type StructuredOutputMode =
  | "json_schema"
  | "json_mode"
  | "response_mime_type"
  | "tool_schema"
  | "prompt_json";

export type ProviderInstructionProfile =
  | "mock-json-schema-v1"
  | "openai-json-schema-v1"
  | "gemini-json-mime-v1"
  | "claude-tool-schema-v1";

export type ModelPricingProfile =
  | {
      kind: "per_hundred_total_tokens";
      microsPerHundredTokens: number;
    }
  | {
      kind: "per_million_input_output_tokens";
      inputMicrosPerMillion: number;
      outputMicrosPerMillion: number;
    };

export type ProviderModelProfile = {
  provider: ProviderName;
  model: string;
  enabled: boolean;
  selectableForAnalysis: boolean;
  eligibleForClassification: boolean;
  anonymousEligible: boolean;
  loggedInEligible: boolean;
  adapterSupported: boolean;
  queueName:
    | "mock_queue"
    | "openai_queue"
    | "gemini_queue"
    | "claude_queue";
  structuredOutputCapabilities: readonly StructuredOutputMode[];
  preferredStructuredOutputMode: StructuredOutputMode;
  providerInstructionProfile: ProviderInstructionProfile;
  maximumOutputTokens: Readonly<Record<PromptDepth, number>>;
  defaultRequestSettings: Readonly<{
    temperature: number;
  }>;
  supportedPromptDepths: readonly PromptDepth[];
  pricingProfile: ModelPricingProfile;
  outputTokenMultiplier: number;
  modelProfileVersion: string;
};

const ALL_DEPTHS = ["weak", "medium", "high"] as const;

export const PROVIDER_MODEL_REGISTRY = [
  {
    provider: "mock",
    model: "mock-fast",
    enabled: true,
    selectableForAnalysis: true,
    eligibleForClassification: true,
    anonymousEligible: true,
    loggedInEligible: true,
    adapterSupported: true,
    queueName: "mock_queue",
    structuredOutputCapabilities: ["json_schema"],
    preferredStructuredOutputMode: "json_schema",
    providerInstructionProfile: "mock-json-schema-v1",
    maximumOutputTokens: { weak: 128, medium: 256, high: 512 },
    defaultRequestSettings: { temperature: 0 },
    supportedPromptDepths: ALL_DEPTHS,
    pricingProfile: {
      kind: "per_hundred_total_tokens",
      microsPerHundredTokens: 1
    },
    outputTokenMultiplier: 0.75,
    modelProfileVersion: "mock-fast-profile-v1"
  },
  {
    provider: "mock",
    model: "mock-standard",
    enabled: true,
    selectableForAnalysis: true,
    eligibleForClassification: true,
    anonymousEligible: false,
    loggedInEligible: true,
    adapterSupported: true,
    queueName: "mock_queue",
    structuredOutputCapabilities: ["json_schema"],
    preferredStructuredOutputMode: "json_schema",
    providerInstructionProfile: "mock-json-schema-v1",
    maximumOutputTokens: { weak: 192, medium: 384, high: 768 },
    defaultRequestSettings: { temperature: 0 },
    supportedPromptDepths: ALL_DEPTHS,
    pricingProfile: {
      kind: "per_hundred_total_tokens",
      microsPerHundredTokens: 2
    },
    outputTokenMultiplier: 1,
    modelProfileVersion: "mock-standard-profile-v1"
  },
  {
    provider: "mock",
    model: "mock-quality",
    enabled: true,
    selectableForAnalysis: true,
    eligibleForClassification: true,
    anonymousEligible: false,
    loggedInEligible: true,
    adapterSupported: true,
    queueName: "mock_queue",
    structuredOutputCapabilities: ["json_schema"],
    preferredStructuredOutputMode: "json_schema",
    providerInstructionProfile: "mock-json-schema-v1",
    maximumOutputTokens: { weak: 256, medium: 512, high: 1024 },
    defaultRequestSettings: { temperature: 0 },
    supportedPromptDepths: ALL_DEPTHS,
    pricingProfile: {
      kind: "per_hundred_total_tokens",
      microsPerHundredTokens: 3
    },
    outputTokenMultiplier: 1.25,
    modelProfileVersion: "mock-quality-profile-v1"
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    enabled: true,
    selectableForAnalysis: true,
    eligibleForClassification: true,
    anonymousEligible: false,
    loggedInEligible: true,
    adapterSupported: true,
    queueName: "openai_queue",
    structuredOutputCapabilities: ["json_schema", "json_mode"],
    preferredStructuredOutputMode: "json_schema",
    providerInstructionProfile: "openai-json-schema-v1",
    maximumOutputTokens: { weak: 512, medium: 1024, high: 2048 },
    defaultRequestSettings: { temperature: 0 },
    supportedPromptDepths: ALL_DEPTHS,
    pricingProfile: {
      kind: "per_million_input_output_tokens",
      inputMicrosPerMillion: 150_000,
      outputMicrosPerMillion: 600_000
    },
    outputTokenMultiplier: 1,
    modelProfileVersion: "gpt-4o-mini-profile-v1"
  },
  {
    provider: "gemini",
    model: "gemini-1.5-flash",
    enabled: true,
    selectableForAnalysis: true,
    eligibleForClassification: true,
    anonymousEligible: false,
    loggedInEligible: true,
    adapterSupported: true,
    queueName: "gemini_queue",
    structuredOutputCapabilities: ["response_mime_type", "prompt_json"],
    preferredStructuredOutputMode: "response_mime_type",
    providerInstructionProfile: "gemini-json-mime-v1",
    maximumOutputTokens: { weak: 512, medium: 1024, high: 2048 },
    defaultRequestSettings: { temperature: 0 },
    supportedPromptDepths: ALL_DEPTHS,
    pricingProfile: {
      kind: "per_million_input_output_tokens",
      inputMicrosPerMillion: 75_000,
      outputMicrosPerMillion: 300_000
    },
    outputTokenMultiplier: 1,
    modelProfileVersion: "gemini-1.5-flash-profile-v1"
  },
  {
    provider: "claude",
    model: "claude-3-5-sonnet",
    enabled: true,
    selectableForAnalysis: true,
    eligibleForClassification: true,
    anonymousEligible: false,
    loggedInEligible: true,
    adapterSupported: true,
    queueName: "claude_queue",
    structuredOutputCapabilities: ["tool_schema", "prompt_json"],
    preferredStructuredOutputMode: "tool_schema",
    providerInstructionProfile: "claude-tool-schema-v1",
    maximumOutputTokens: { weak: 512, medium: 1024, high: 2048 },
    defaultRequestSettings: { temperature: 0 },
    supportedPromptDepths: ALL_DEPTHS,
    pricingProfile: {
      kind: "per_million_input_output_tokens",
      inputMicrosPerMillion: 3_000_000,
      outputMicrosPerMillion: 15_000_000
    },
    outputTokenMultiplier: 1.25,
    modelProfileVersion: "claude-3-5-sonnet-profile-v1"
  }
] as const satisfies readonly ProviderModelProfile[];

export const MAX_ANALYSIS_PROVIDER_MODELS =
  PROVIDER_MODEL_REGISTRY.filter(
    (profile) => profile.enabled && profile.selectableForAnalysis
  ).length;

export function providerModelProfile(provider: ProviderName, model: string) {
  return (
    PROVIDER_MODEL_REGISTRY.find(
      (profile) => profile.provider === provider && profile.model === model
    ) ?? null
  );
}

export function enabledAnalysisProfiles(provider?: ProviderName) {
  return PROVIDER_MODEL_REGISTRY.filter(
    (profile) =>
      profile.enabled &&
      profile.selectableForAnalysis &&
      (provider === undefined || profile.provider === provider)
  );
}

export function classificationProfile(provider: ProviderName, model: string) {
  const profile = providerModelProfile(provider, model);
  return profile?.enabled && profile.eligibleForClassification ? profile : null;
}

