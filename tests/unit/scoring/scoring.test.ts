import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateProviderScore } from "../../../src/utils/score-calculators.js";

describe("backend provider scoring", () => {
  it("uses the authoritative visibility formula without confidence inflation", () => {
    const calculation = calculateProviderScore({
      promptType: "visibility",
      provider: "mock",
      model: "mock-standard",
      validatedResponse: {
        result: {
          mention_likelihood: 0.8,
          recommendation_likelihood: 0.7,
          competitive_prominence: 0.6,
          confidence: 0.1
        }
      }
    });
    assert.equal(calculation.metricType, "visibility");
    assert.equal(calculation.score, 72.5);
    assert.equal(calculation.components.confidence, 0.1);
  });

  it("scores found and valid-negative ranking evidence", () => {
    const found = calculateProviderScore({
      promptType: "ranking",
      provider: "mock",
      model: "mock-fast",
      validatedResponse: {
        result: {
          found: true,
          requested_top_k: 10,
          rank_position: 5,
          confidence: 0.9
        },
        score: 100
      }
    });
    const missing = calculateProviderScore({
      promptType: "ranking",
      provider: "mock",
      model: "mock-fast",
      validatedResponse: {
        result: {
          found: false,
          requested_top_k: 10,
          rank_position: null,
          confidence: 0.9
        }
      }
    });
    assert.equal(found.score, 60);
    assert.equal(missing.score, 0);
  });

  it("rejects diagnostic prompt types as non-scorable", () => {
    assert.throws(() =>
      calculateProviderScore({
        promptType: "competitor",
        provider: "mock",
        model: "mock-standard",
        validatedResponse: { result: {} }
      })
    );
  });
});
