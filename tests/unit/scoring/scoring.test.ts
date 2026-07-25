import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateProviderScore } from "../../../src/utils/score-calculators.js";

describe("backend provider scoring", () => {
  it("computes deterministic prompt-specific scores from evidence confidence", () => {
    const response = {
      evidence: [
        { claim: "one", confidence: 0.8 },
        { claim: "two", confidence: 0.6 }
      ]
    };
    const visibility = calculateProviderScore({
      promptType: "visibility",
      promptVersion: "v1",
      provider: "mock",
      model: "mock-standard",
      parsedResponse: response
    });
    const competitor = calculateProviderScore({
      promptType: "competitor",
      promptVersion: "v1",
      provider: "mock",
      model: "mock-standard",
      parsedResponse: response
    });

    assert.equal(visibility.score, 70);
    assert.equal(competitor.score, 63);
    assert.deepEqual(visibility.components, {
      scoreType: "visibility_score",
      scoringVersion: "backend-v1",
      promptType: "visibility",
      promptVersion: "v1",
      provider: "mock",
      model: "mock-standard",
      baseline: 70,
      evidenceCount: 2,
      evidenceConfidence: 0.7,
      formula: "70% prompt baseline + 30% mean evidence confidence"
    });
  });

  it("does not trust a provider-supplied score field", () => {
    const result = calculateProviderScore({
      promptType: "ranking",
      promptVersion: "v1_light",
      provider: "mock",
      model: "mock-fast",
      parsedResponse: {
        score: 100,
        evidence: [{ confidence: 0.5 }]
      }
    });

    assert.equal(result.score, 60.5);
  });
});
