import type { JsonObject } from "../types/database.types.js";
import type {
  ProviderAdapter,
  ProviderExecutionRequest
} from "./provider-adapter.types.js";
import { isMockModel } from "./provider-model.policy.js";

export class MockProviderAdapter implements ProviderAdapter {
  readonly provider = "mock" as const;

  supportsModel(model: string) {
    return isMockModel(model);
  }

  async execute(request: ProviderExecutionRequest) {
    const parsedEvidence = deterministicEvidence(
      request.providerJobId,
      request.promptType,
      request.model
    );
    const inputTokens = Math.max(1, Math.ceil(request.promptText.length / 4));
    return {
      rawResponse: parsedEvidence,
      parsedEvidence,
      inputTokens,
      outputTokens: 32,
      totalTokens: inputTokens + 32,
      finishReason: "mock_complete",
      providerRequestId: `mock:${request.providerJobId}`,
      modelVersion: request.model,
      latencyMs: 0
    };
  }
}

function deterministicEvidence(
  providerJobId: string,
  promptType: string,
  model: string
): JsonObject {
  return {
    provider: "mock",
    model,
    promptType,
    evidence: [
      {
        claim: `Mock ${promptType} evidence for the selected entity path.`,
        source: "mock-provider",
        confidence: 0.75
      }
    ],
    summary: "Deterministic mock provider response.",
    evidenceId: `mock-evidence:${providerJobId}`
  };
}
