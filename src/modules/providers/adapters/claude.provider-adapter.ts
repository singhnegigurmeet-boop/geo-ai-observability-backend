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
  hierarchyDiscoveryResponseJsonSchema,
  normalResponseJsonSchema
} from "../contracts/provider-response.contracts.js";
import { providerModelProfile } from "../registry/provider-model.registry.js";
import type { PromptType } from "../../../common/types/database.types.js";

export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;

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
        max_tokens: request.maximumOutputTokens,
        temperature: 0,
        messages: [{ role: "user", content: request.promptText }],
        tools: [
          {
            name: "submit_geo_result",
            description: "Submit the strict GEO response contract.",
            input_schema:
              request.discoveryStage
                ? hierarchyDiscoveryResponseJsonSchema(request.discoveryStage)
                : normalResponseJsonSchema(
                    request.promptType as PromptType,
                    request.responseContractVersion
                  )
          }
        ],
        tool_choice: { type: "tool", name: "submit_geo_result" }
      },
      timeoutMs: request.timeoutMs
    });
    if (response.status < 200 || response.status >= 300) {
      throw providerHttpError("Claude", response.status);
    }
    const raw = asObject(response.body, "Claude");
    const blocks = Array.isArray(raw.content) ? raw.content : [];
    const toolInput = blocks
      .map((block) => {
        const item = objectAt(block);
        return item?.type === "tool_use" &&
          item.name === "submit_geo_result" &&
          item.input &&
          typeof item.input === "object"
          ? item.input
          : null;
      })
      .find((item) => item !== null);
    const text = blocks
      .map((block) => {
        const item = objectAt(block);
        return item?.type === "text" ? stringAt(item.text) : null;
      })
      .filter((part): part is string => part !== null)
      .join("");
    if (!toolInput && !text) throw malformed("Claude", raw);
    const usage = objectAt(raw.usage);
    const inputTokens = nonnegativeInteger(usage?.input_tokens);
    const outputTokens = nonnegativeInteger(usage?.output_tokens);
    return {
      generatedContent: toolInput ? JSON.stringify(toolInput) : text,
      sanitizedProviderMetadata: {
        contentBlockCount: blocks.length,
        usedToolOutput: Boolean(toolInput)
      },
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
