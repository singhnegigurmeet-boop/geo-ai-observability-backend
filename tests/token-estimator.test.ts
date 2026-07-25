import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateCostMicros } from "../src/budgets/provider-pricing.policy.js";
import { TokenEstimatorService } from "../src/budgets/token-estimator.service.js";

describe("Phase 10 token and pricing estimation", () => {
  it("is deterministic and model specific", () => {
    const estimator = new TokenEstimatorService();
    const common = {
      provider: "mock" as const,
      promptText: "x".repeat(400),
      promptType: "pros_cons" as const,
      promptVersion: "v1"
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

  it("uses integer micros and rejects providers without a Phase 10 policy", () => {
    assert.equal(
      estimateCostMicros({
        provider: "mock",
        model: "mock-quality",
        totalTokens: 101
      }),
      4
    );
    assert.throws(() =>
      estimateCostMicros({
        provider: "openai",
        model: "gpt-4o-mini",
        totalTokens: 100
      })
    );
  });
});
