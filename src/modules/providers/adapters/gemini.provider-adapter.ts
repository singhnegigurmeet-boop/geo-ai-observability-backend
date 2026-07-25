import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderHttpClient
} from "../types/provider-adapter.types.js";
import { ProviderExecutionError, providerHttpError } from "../errors/provider-execution.error.js";
import {
  asObject,
  malformed,
  nonnegativeInteger,
  normalizedEvidence,
  objectAt,
  stringAt
} from "../../../utils/provider-response.js";

export class GeminiProviderAdapter implements ProviderAdapter {
  readonly provider = "gemini" as const;

  constructor(
    private readonly http: ProviderHttpClient,
    private readonly apiKey: string | undefined
  ) {}

  supportsModel(model: string) {
    return model === "gemini-1.5-flash";
  }

  async execute(request: ProviderExecutionRequest) {
    if (!this.apiKey) {
      throw new ProviderExecutionError(
        "PROVIDER_API_KEY_MISSING",
        "Gemini API key is not configured",
        true
      );
    }
    if (!this.supportsModel(request.model)) {
      throw new ProviderExecutionError(
        "UNSUPPORTED_PROVIDER_MODEL",
        "Unsupported Gemini model",
        true
      );
    }
    const startedAt = Date.now();
    const response = await this.http.postJson({
      url:
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(request.model)}:generateContent`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey
      },
      body: {
        contents: [{ role: "user", parts: [{ text: request.promptText }] }]
      },
      timeoutMs: request.timeoutMs
    });
    if (response.status < 200 || response.status >= 300) {
      throw providerHttpError("Gemini", response.status);
    }
    const raw = asObject(response.body, "Gemini");
    const candidate = Array.isArray(raw.candidates)
      ? objectAt(raw.candidates[0])
      : null;
    const content = objectAt(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const text = parts
      .map((part) => stringAt(objectAt(part)?.text))
      .filter((part): part is string => part !== null)
      .join("");
    const blockReason = stringAt(objectAt(raw.promptFeedback)?.blockReason);
    if (!candidate && !blockReason) throw malformed("Gemini", raw);
    const answer = text || `Gemini refusal: ${blockReason ?? "empty response"}`;
    const usage = objectAt(raw.usageMetadata);
    return {
      rawResponse: raw,
      parsedEvidence: normalizedEvidence({
        provider: this.provider,
        model: request.model,
        promptType: request.promptType,
        text: answer,
        refusal: !text
      }),
      inputTokens: nonnegativeInteger(usage?.promptTokenCount),
      outputTokens: nonnegativeInteger(usage?.candidatesTokenCount),
      totalTokens: nonnegativeInteger(usage?.totalTokenCount),
      finishReason: stringAt(candidate?.finishReason) ?? blockReason,
      providerRequestId: stringAt(raw.responseId),
      modelVersion: stringAt(raw.modelVersion) ?? request.model,
      latencyMs: Date.now() - startedAt
    };
  }
}
