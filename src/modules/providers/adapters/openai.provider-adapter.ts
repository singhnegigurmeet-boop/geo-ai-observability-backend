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
  objectAt,
  stringAt
} from "../../../utils/provider-response.js";
import {
  classificationResponseJsonSchema,
  normalResponseJsonSchema
} from "../contracts/provider-response.contracts.js";
import { providerModelProfile } from "../registry/provider-model.registry.js";

export class OpenAiProviderAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;

  constructor(
    private readonly http: ProviderHttpClient,
    private readonly apiKey: string | undefined
  ) {}

  supportsModel(model: string) {
    const profile = providerModelProfile(this.provider, model);
    return Boolean(profile?.enabled && profile.adapterSupported);
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
        messages: [{ role: "user", content: request.promptText }],
        temperature: 0,
        max_completion_tokens: request.maximumOutputTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.responseContractVersion.replaceAll("-", "_"),
            strict: true,
            schema:
              request.promptType === "domain_category_classification"
                ? classificationResponseJsonSchema()
                : normalResponseJsonSchema(
                    request.promptType,
                    request.responseContractVersion
                  )
          }
        }
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
    if (!choice || !message || text === null) throw malformed("OpenAI", raw);
    const usage = objectAt(raw.usage);
    return {
      generatedContent: text,
      sanitizedProviderMetadata: {
        choiceCount: Array.isArray(raw.choices) ? raw.choices.length : 0
      },
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
