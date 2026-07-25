import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBasicReport } from "../src/reports/report-aggregation.service.js";

describe("basic report aggregation", () => {
  it("groups backend scores and summarizes provider usage deterministically", () => {
    const report = buildBasicReport("9", [
      score("visibility", "70.0000", 10, 20),
      score("visibility", "80.0000", 15, 25),
      score("ranking", "60.0000", 5, 10)
    ]);

    assert.equal(report.overallScore, 70);
    assert.equal(report.reportType, "basic_report");
    assert.deepEqual(report.breakdown, [
      {
        promptType: "ranking",
        score: 60,
        summary:
          "Backend interpretation indicates moderate ranking evidence.",
        evidenceCount: 1
      },
      {
        promptType: "visibility",
        score: 75,
        summary:
          "Backend interpretation indicates strong visibility evidence.",
        evidenceCount: 2
      }
    ]);
    assert.deepEqual(report.providerModels, [
      { provider: "mock", model: "mock-standard" }
    ]);
    assert.deepEqual(report.usage, {
      inputTokens: 30,
      outputTokens: 55,
      costMicros: 0
    });
  });
});

function score(
  promptType: "visibility" | "ranking",
  value: string,
  inputTokens: number,
  outputTokens: number
) {
  return {
    prompt_type: promptType,
    score: value,
    score_components: {},
    provider: "mock" as const,
    model: "mock-standard",
    parsed_response: { evidence: [{ confidence: 0.75 }] },
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_micros: "0"
  };
}
