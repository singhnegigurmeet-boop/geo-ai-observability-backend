import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMultiProviderReport } from "../src/reports/report-aggregation.service.js";

describe("multi-provider report aggregation", () => {
  it("averages valid sibling scores and retains provider provenance", () => {
    const report = buildMultiProviderReport(
      "9",
      [
        record("1", "visibility", "openai", "gpt-4o-mini", "70.0000", 10),
        record(
          "1",
          "visibility",
          "gemini",
          "gemini-1.5-flash",
          "80.0000",
          20
        ),
        record("2", "ranking", "claude", "claude-3-5-sonnet", "60.0000", 5)
      ],
      "processing"
    );

    assert.equal(report.overallScore, 67.5);
    assert.equal(report.lifecycleState, "completed");
    assert.deepEqual(report.promptScores, [
      {
        promptJobId: "1",
        promptType: "visibility",
        promptVersion: "v1",
        score: 75,
        scoredProviders: 2,
        expectedProviders: 2
      },
      {
        promptJobId: "2",
        promptType: "ranking",
        promptVersion: "v1",
        score: 60,
        scoredProviders: 1,
        expectedProviders: 1
      }
    ]);
    assert.deepEqual(
      report.providerResults.map((item) => ({
        provider: item.provider,
        model: item.model,
        score: item.score
      })),
      [
        { provider: "openai", model: "gpt-4o-mini", score: 70 },
        { provider: "gemini", model: "gemini-1.5-flash", score: 80 },
        { provider: "claude", model: "claude-3-5-sonnet", score: 60 }
      ]
    );
    assert.deepEqual(report.usage, {
      inputTokens: 35,
      outputTokens: 30,
      costMicros: 3
    });
  });

  it("does not treat invalid or failed siblings as zero", () => {
    const valid = record(
      "1",
      "visibility",
      "openai",
      "gpt-4o-mini",
      "80.0000",
      10
    );
    const invalid = {
      ...record(
        "1",
        "visibility",
        "gemini",
        "gemini-1.5-flash",
        null,
        0
      ),
      provider_job_status: "failed" as const,
      result_status: "invalid" as const,
      parsed_response: null
    };
    const report = buildMultiProviderReport(
      "9",
      [valid, invalid],
      "partial_success"
    );
    assert.equal(report.overallScore, 80);
    assert.equal(report.lifecycleState, "completed_with_gaps");
    assert.equal(report.counts.invalid, 1);
  });
});

function record(
  promptJobId: string,
  promptType: "visibility" | "ranking",
  provider: "openai" | "gemini" | "claude",
  model: string,
  score: string | null,
  inputTokens: number
) {
  return {
    prompt_job_id: promptJobId,
    prompt_type: promptType,
    prompt_version: "v1",
    provider_job_id: `${promptJobId}-${provider}`,
    provider,
    model,
    provider_job_status: "succeeded" as const,
    error_code: null,
    result_status: "valid" as const,
    parsed_response: { evidence: [{ confidence: 0.75 }] },
    scoring_version: score === null ? null : "backend-v1",
    score,
    score_components: score === null ? null : {},
    input_tokens: inputTokens,
    output_tokens: 10,
    cost_micros: "1"
  };
}
