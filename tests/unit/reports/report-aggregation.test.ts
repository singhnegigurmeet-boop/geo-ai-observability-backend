import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMultiProviderReport
} from "../../../src/modules/reports/services/report-aggregation.service.js";
import type {
  ReportExecutionRecord
} from "../../../src/modules/reports/repositories/report.repository.js";

describe("multi-provider GEO report aggregation", () => {
  it("renormalizes partial model metrics and gives available models equal weight", () => {
    const report = buildMultiProviderReport(
      "9",
      [
        record("1", "visibility", "openai", "gpt-4o-mini", "70.0000", 10),
        record("1", "visibility", "gemini", "gemini-1.5-flash", "80.0000", 20),
        record("2", "ranking", "claude", "claude-3-5-sonnet", "60.0000", 5)
      ],
      "processing"
    );
    assert.equal(report.overallScore, 70);
    assert.equal(report.lifecycleState, "completed");
    assert.equal(report.modelPathScores.length, 3);
    assert.ok(report.modelPathScores.every((entry) => entry.partial));
    assert.equal(report.executiveSummary.scoreBand, "moderate");
    assert.equal(report.overallDimensions.averageVisibilityScore, 75);
    assert.equal(report.overallDimensions.averageRankingScore, 60);
    assert.equal(report.providerModelComparison.length, 3);
    assert.equal(report.visibility.length, 2);
    assert.equal(report.ranking.length, 1);
    assert.deepEqual(report.coverage, report.counts);
    assert.deepEqual(report.usage, {
      inputTokens: 35,
      outputTokens: 30,
      costMicros: 3
    });
  });

  it("does not convert invalid or unavailable evidence into zero", () => {
    const valid = record(
      "1",
      "visibility",
      "openai",
      "gpt-4o-mini",
      "80.0000",
      10
    );
    const invalid: ReportExecutionRecord = {
      ...record(
        "1",
        "visibility",
        "gemini",
        "gemini-1.5-flash",
        null,
        0
      ),
      provider_job_status: "succeeded",
      result_status: "invalid",
      validated_response: null,
      validation_errors: [
        { code: "RAW_JSON_PARSE_ERROR", message: "invalid JSON" }
      ]
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
): ReportExecutionRecord {
  return {
    prompt_job_id: promptJobId,
    prompt_type: promptType,
    prompt_depth: "medium",
    business_prompt_version: `${promptType}-v1`,
    response_contract_version: `${promptType}-response-v1`,
    entity_path_id: "100",
    category_id: "10",
    category_name: "Software",
    provider_job_id: `${promptJobId}-${provider}`,
    provider,
    model,
    provider_job_status: "succeeded",
    error_code: null,
    result_status: "valid",
    validated_response: {
      result: { confidence: 0.75 },
      evidence: [{ confidence: 0.75 }]
    },
    validation_errors: [],
    metric_type: score === null ? null : promptType,
    scoring_version: score === null ? null : "geo-backend-v1",
    score,
    score_components: score === null ? null : {},
    scoring_failure_code: null,
    input_tokens: inputTokens,
    output_tokens: 10,
    cost_micros: "1"
  };
}
