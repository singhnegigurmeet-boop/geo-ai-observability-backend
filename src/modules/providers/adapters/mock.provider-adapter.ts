import type {
  JsonObject,
  PromptType
} from "../../../common/types/database.types.js";
import { PROMPT_DEPTH_LIMITS } from "../../prompts/policies/prompt-policy.registry.js";
import type {
  ProviderAdapter,
  ProviderExecutionRequest
} from "../types/provider-adapter.types.js";
import { isMockModel } from "../policies/provider-model.policy.js";
import { providerModelProfile } from "../registry/provider-model.registry.js";

export class MockProviderAdapter implements ProviderAdapter {
  readonly provider = "mock" as const;

  supportsModel(model: string) {
    return isMockModel(model);
  }

  async execute(request: ProviderExecutionRequest) {
    const response = deterministicResponse(request);
    const generatedContent = JSON.stringify(response);
    const inputTokens = Math.max(1, Math.ceil(request.promptText.length / 4));
    const modelProfile = providerModelProfile("mock", request.model);
    const outputTokens = Math.min(
      modelProfile?.maximumOutputTokens[request.promptDepth] ??
        Number.POSITIVE_INFINITY,
      Math.max(1, Math.ceil(generatedContent.length / 4))
    );
    return {
      generatedContent,
      sanitizedProviderMetadata: { deterministic: true },
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      finishReason: "mock_complete",
      providerRequestId: `mock:${request.providerJobId}`,
      modelVersion: request.model,
      latencyMs: 0
    };
  }
}

function deterministicResponse(request: ProviderExecutionRequest): JsonObject {
  if (request.discoveryStage) {
    const first = request.discoveryCandidates?.[0];
    const field = request.discoveryStage === "brand" || request.discoveryStage === "product"
      ? "items"
      : "selections";
    const identity: JsonObject = request.discoveryStage === "category"
      ? first ? { category_id: first.id } : {}
      : request.discoveryStage === "use_context"
        ? first ? { use_context_id: first.id } : {}
        : { name: request.discoveryStage === "brand" ? "Example Brand" : "Example Product" };
    return {
      prompt_type: `hierarchy_discovery_${request.discoveryStage}`,
      contract_version: request.responseContractVersion,
      [field]: first || request.discoveryStage === "brand" || request.discoveryStage === "product"
        ? [
            {
              ...identity,
              rank: 1,
              confidence: 0.75,
              reason: "Deterministic hierarchy discovery result."
            }
          ]
        : [],
      summary: "Deterministic hierarchy discovery response."
    };
  }
  const result = resultFor(request.promptType as PromptType, request);
  return {
    prompt_type: request.promptType,
    contract_version: request.responseContractVersion,
    result,
    evidence: [
      {
        claim: `Deterministic ${request.promptType} evidence for the exact entity path.`,
        source: "mock-provider",
        confidence: 0.75
      }
    ],
    summary: "Deterministic mock provider response."
  };
}

function resultFor(
  promptType: PromptType,
  request: ProviderExecutionRequest
): JsonObject {
  switch (promptType) {
    case "visibility":
      return {
        target_mentioned: true,
        mention_likelihood: 0.75,
        recommendation_likelihood: 0.7,
        competitive_prominence: 0.65,
        query_intents: ["category discovery"],
        strengths: ["Clear target context"],
        visibility_gaps: ["Limited independent evidence"],
        confidence: 0.75
      };
    case "ranking":
      return {
        requested_top_k: PROMPT_DEPTH_LIMITS[request.promptDepth].topK,
        found: true,
        rank_position: 1,
        ordered_candidates: [{ rank: 1, name: request.exactTargetName }],
        mention_count: 1,
        confidence: 0.75
      };
    case "competitor":
      return {
        direct_competitors: [],
        indirect_competitors: [],
        target_differentiation: "Exact target context is preserved.",
        competitive_pressure: 0.5,
        confidence: 0.75
      };
    case "price_range":
      return {
        applicability: "unknown",
        currency: null,
        minimum: null,
        maximum: null,
        pricing_basis: "No reliable public price was supplied.",
        uncertainty: "Pricing requires current public evidence.",
        confidence: 0.25
      };
    case "pros_cons":
      return {
        pros: ["Exact context is represented"],
        cons: ["Independent evidence is limited"],
        best_fit_for: ["The specified use context"],
        poor_fit_for: ["Unspecified contexts"],
        comparison_context: "The exact frozen entity path.",
        confidence: 0.75
      };
  }
}
