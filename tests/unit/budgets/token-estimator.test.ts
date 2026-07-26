import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateCostMicros } from "../../../src/modules/budgets/policies/provider-pricing.policy.js";
import { TokenEstimatorService } from "../../../src/modules/budgets/services/token-estimator.service.js";

describe("Token and pricing estimation", () => {
  it("is deterministic and model specific", () => {
    const estimator = new TokenEstimatorService();
    const common = {
      provider: "mock" as const,
      promptText: "x".repeat(400),
      promptType: "pros_cons" as const,
      promptDepth: "medium" as const
    };
    const fast = estimator.estimate({ ...common, model: "mock-fast" });
    const standard = estimator.estimate({
      ...common,
      model: "mock-standard"
    });
    const quality = estimator.estimate({
      ...common,
      model: "mock-quality"
    });

    assert.equal(fast.inputTokens, 100);
    assert.ok(fast.outputTokens < standard.outputTokens);
    assert.ok(standard.outputTokens < quality.outputTokens);
    assert.ok(fast.costMicros < standard.costMicros);
    assert.ok(standard.costMicros < quality.costMicros);
    assert.deepEqual(
      estimator.estimate({ ...common, model: "mock-standard" }),
      standard
    );
  });

  it("uses integer micros for mock and allowed real provider models", () => {
    assert.equal(
      estimateCostMicros({
        provider: "mock",
        model: "mock-quality",
        totalTokens: 101
      }),
      4
    );
    assert.equal(
      estimateCostMicros({
        provider: "openai",
        model: "gpt-4o-mini",
        inputTokens: 100,
        outputTokens: 50
      }),
      45
    );
    assert.throws(() =>
      estimateCostMicros({
        provider: "openai",
        model: "gemini-1.5-flash",
        inputTokens: 100,
        outputTokens: 50
      })
    );
  });
});
