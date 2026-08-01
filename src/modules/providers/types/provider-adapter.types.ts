import type {
  JsonObject,
  PromptDepth,
  PromptType,
  ProviderName
} from "../../../common/types/database.types.js";

export type ProviderExecutionRequest = {
  providerJobId: string;
  provider: ProviderName;
  model: string;
  promptText: string;
  promptType: PromptType | `hierarchy_discovery_${"category" | "brand" | "product" | "use_context"}`;
  promptDepth: PromptDepth;
  responseContractVersion: string;
  structuredOutputMode: string;
  maximumOutputTokens: number;
  exactTargetName: string;
  discoveryStage?: "category" | "brand" | "product" | "use_context";
  discoveryCandidates?: Array<{ id: string; name: string }>;
  timeoutMs: number;
};

export type ProviderGeneratedOutput = {
  generatedContent: string;
  sanitizedProviderMetadata: JsonObject;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  providerRequestId: string | null;
  modelVersion: string | null;
  latencyMs: number;
};

export interface ProviderAdapter {
  readonly provider: ProviderName;
  supportsModel(model: string): boolean;
  execute(request: ProviderExecutionRequest): Promise<ProviderGeneratedOutput>;
}

export type ProviderHttpRequest = {
  url: string;
  headers: Record<string, string>;
  body: JsonObject;
  timeoutMs: number;
};

export type ProviderHttpResponse = {
  status: number;
  body: unknown;
};

export interface ProviderHttpClient {
  postJson(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}
