import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReportExecutionRecord } from "../../../src/modules/reports/repositories/report.repository.js";
import type { JsonObject } from "../../../src/common/types/database.types.js";
import { consolidateDiagnostics } from "../../../src/modules/reports/services/report-consolidation.service.js";

describe("deterministic report diagnostic consolidation", () => {
  it("ignores not-found for average rank while retaining it in found rate", () => {
    const report = consolidateDiagnostics([
      record("ranking", "a", {
        requested_top_k: 10,
        found: true,
        rank_position: 2,
        ordered_candidates: []
      }),
      record("ranking", "b", {
        requested_top_k: 10,
        found: false,
        rank_position: null,
        ordered_candidates: []
      })
    ]);
    assert.equal((report.ranking[0]?.rank as JsonObject).average, 2);
    assert.equal(report.ranking[0]?.foundRate, 0.5);
    assert.equal(report.ranking[0]?.notFoundCount, 1);
  });

  it("separates currencies and exposes applicability contradictions", () => {
    const report = consolidateDiagnostics([
      record("price_range", "a", {
        applicability: "applicable",
        currency: "USD",
        minimum: 10,
        maximum: 20
      }),
      record("price_range", "b", {
        applicability: "applicable",
        currency: "EUR",
        minimum: 8,
        maximum: 18
      }),
      record("price_range", "c", {
        applicability: "unknown",
        currency: null,
        minimum: null,
        maximum: null
      })
    ]);
    assert.equal(report.price[0]?.incompatibleCurrencyWarning, true);
    assert.equal(report.price[0]?.applicabilityContradiction, true);
    assert.equal(
      (report.price[0]?.rangesByCurrency as unknown[]).length,
      2
    );
  });

  it("finds conservative direct/indirect and pro/con contradictions", () => {
    const report = consolidateDiagnostics([
      record("competitor", "a", {
        direct_competitors: [
          { name: "Acme  Corp", relevance_rank: 1, reason_for_overlap: "scope" }
        ],
        indirect_competitors: []
      }),
      record("competitor", "b", {
        direct_competitors: [],
        indirect_competitors: [
          { name: "acme corp", relevance_rank: 2, reason_for_overlap: "adjacent" }
        ]
      }),
      record("pros_cons", "a", {
        pros: ["Easy setup"],
        cons: [],
        best_fit_for: [],
        poor_fit_for: []
      }),
      record("pros_cons", "b", {
        pros: [],
        cons: [" easy   setup "],
        best_fit_for: [],
        poor_fit_for: []
      })
    ]);
    assert.deepEqual(
      (report.competitors[0]?.directIndirectContradictions as JsonObject)
        .items,
      ["acme corp"]
    );
    assert.deepEqual(
      (report.prosAndCons[0]?.contradictions as JsonObject).items,
      ["easy   setup"]
    );
  });
});

function record(
  promptType: ReportExecutionRecord["prompt_type"],
  model: string,
  result: JsonObject
): ReportExecutionRecord {
  return {
    analysis_run_item_id: "1",
    item_ordinal: 0,
    prompt_job_id: `${promptType}-${model}`,
    prompt_type: promptType,
    prompt_depth: "medium",
    business_prompt_version: `${promptType}-v1`,
    response_contract_version: `${promptType}-response-v1`,
    entity_path_id: "10",
    category_id: "5",
    category_name: "Software",
    provider_job_id: `job-${model}`,
    provider_result_id: `result-${model}`,
    provider_score_id: null,
    provider: "mock",
    model,
    provider_job_status: "succeeded",
    error_code: null,
    result_status: "valid",
    context_validation_status: "valid",
    validated_response: { result },
    validation_errors: [],
    metric_type: null,
    scoring_version: null,
    score: null,
    score_components: null,
    scoring_failure_code: null,
    input_tokens: 10,
    output_tokens: 5,
    cost_micros: "1"
  };
}
