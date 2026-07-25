import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderHttpClient
} from "./provider-adapter.types.js";
import { ProviderExecutionError, providerHttpError } from "./provider-execution.error.js";
import {
  asObject,
  malformed,
  nonnegativeInteger,
  normalizedEvidence,
  objectAt,
  stringAt
} from "./provider-response.helpers.js";

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;

  constructor(
    private readonly http: ProviderHttpClient,
    private readonly apiKey: string | undefined
  ) {}

  supportsModel(model: string) {
    return model === "claude-3-5-sonnet";
  }

  async execute(request: ProviderExecutionRequest) {
    if (!this.apiKey) {
      throw new ProviderExecutionError(
        "PROVIDER_API_KEY_MISSING",
        "Claude API key is not configured",
        true
      );
    }
    if (!this.supportsModel(request.model)) {
      throw new ProviderExecutionError(
        "UNSUPPORTED_PROVIDER_MODEL",
        "Unsupported Claude model",
        true
      );
    }
    const startedAt = Date.now();
    const response = await this.http.postJson({
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: {
        model: request.model,
        max_tokens: 512,
        messages: [{ role: "user", content: request.promptText }]
      },
      timeoutMs: request.timeoutMs
    });
    if (response.status < 200 || response.status >= 300) {
      throw providerHttpError("Claude", response.status);
    }
    const raw = asObject(response.body, "Claude");
    const blocks = Array.isArray(raw.content) ? raw.content : [];
    const text = blocks
      .map((block) => {
        const item = objectAt(block);
        return item?.type === "text" ? stringAt(item.text) : null;
      })
      .filter((part): part is string => part !== null)
      .join("");
    if (!text) throw malformed("Claude", raw);
    const usage = objectAt(raw.usage);
    const inputTokens = nonnegativeInteger(usage?.input_tokens);
    const outputTokens = nonnegativeInteger(usage?.output_tokens);
    return {
      rawResponse: raw,
      parsedEvidence: normalizedEvidence({
        provider: this.provider,
        model: request.model,
        promptType: request.promptType,
        text,
        refusal: stringAt(raw.stop_reason) === "refusal"
      }),
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens !== null && outputTokens !== null
          ? inputTokens + outputTokens
          : null,
      finishReason: stringAt(raw.stop_reason),
      providerRequestId: stringAt(raw.id),
      modelVersion: stringAt(raw.model) ?? request.model,
      latencyMs: Date.now() - startedAt
    };
  }
}
