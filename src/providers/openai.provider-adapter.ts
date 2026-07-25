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

export class OpenAiProviderAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;

  constructor(
    private readonly http: ProviderHttpClient,
    private readonly apiKey: string | undefined
  ) {}

  supportsModel(model: string) {
    return model === "gpt-4o-mini";
  }

  async execute(request: ProviderExecutionRequest) {
    if (!this.apiKey) {
      throw new ProviderExecutionError(
        "PROVIDER_API_KEY_MISSING",
        "OpenAI API key is not configured",
        true
      );
    }
    if (!this.supportsModel(request.model)) {
      throw new ProviderExecutionError(
        "UNSUPPORTED_PROVIDER_MODEL",
        "Unsupported OpenAI model",
        true
      );
    }
    const startedAt = Date.now();
    const response = await this.http.postJson({
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: {
        model: request.model,
        messages: [{ role: "user", content: request.promptText }]
      },
      timeoutMs: request.timeoutMs
    });
    if (response.status < 200 || response.status >= 300) {
      throw providerHttpError("OpenAI", response.status);
    }
    const raw = asObject(response.body, "OpenAI");
    const choice = Array.isArray(raw.choices)
      ? objectAt(raw.choices[0])
      : null;
    const message = objectAt(choice?.message);
    const content = stringAt(message?.content);
    const refusal = stringAt(message?.refusal);
    const text = content ?? refusal;
    if (!choice || !message || text === null) throw malformed("OpenAI");
    const usage = objectAt(raw.usage);
    return {
      rawResponse: raw,
      parsedEvidence: normalizedEvidence({
        provider: this.provider,
        model: request.model,
        promptType: request.promptType,
        text,
        refusal: content === null && refusal !== null
      }),
      inputTokens: nonnegativeInteger(usage?.prompt_tokens),
      outputTokens: nonnegativeInteger(usage?.completion_tokens),
      totalTokens: nonnegativeInteger(usage?.total_tokens),
      finishReason: stringAt(choice.finish_reason),
      providerRequestId: stringAt(raw.id),
      modelVersion: stringAt(raw.model) ?? request.model,
      latencyMs: Date.now() - startedAt
    };
  }
}
