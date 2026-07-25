import type {
  JsonObject,
  PromptType,
  ProviderName
} from "../../../common/types/database.types.js";

export type ProviderExecutionRequest = {
  providerJobId: string;
  provider: ProviderName;
  model: string;
  promptText: string;
  promptType: PromptType;
  promptVersion: string;
  timeoutMs: number;
};

export type ProviderExecutionResult = {
  rawResponse: JsonObject;
  parsedEvidence: JsonObject;
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
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
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
