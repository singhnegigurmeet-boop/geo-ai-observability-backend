import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AnalysisExecutionStatus,
  EntityPathType,
  PromptType,
  ProviderName
} from "../../../src/common/types/database.types.js";
import type { ReportMaterializationRecord } from "../../../src/modules/reports/repositories/report.repository.js";
import {
  buildExpectedProviderExecutionPlan,
  type ExpectedPlanItem,
  type ExpectedPlanProviderModel,
  type ExpectedProviderExecution
} from "../../../src/modules/reports/services/expected-execution-plan.service.js";
import {
  reconcileExpectedProviderExecutions,
  type ReconciledExecutionState,
  type ReconciledProviderExecution
} from "../../../src/modules/reports/services/execution-reconciliation.service.js";
import {
  calculateExactCoverage,
  determineReportLifecycle
} from "../../../src/modules/reports/services/report-coverage.service.js";
import { buildMultiProviderReport } from "../../../src/modules/reports/services/report-aggregation.service.js";

describe("exact expected provider execution planning", () => {
  it("builds category × 3 prompts × 2 models as six exact tuples", () => {
    const plan = planFor([item("1", "category")], models(2));
    assert.equal(plan.length, 6);
    assert.equal(new Set(plan.map((entry) => entry.identity)).size, 6);
  });

  it("builds product × 5 prompts × 3 models as fifteen exact tuples", () => {
    assert.equal(planFor([item("1", "product")], models(3)).length, 15);
  });

  it("multiplies multiple items independently", () => {
    assert.equal(
      planFor(
        [item("1", "category", 0), item("2", "product", 1)],
        models(2)
      ).length,
      16
    );
  });

  it("preserves the frozen v1 domain plan with no normal work", () => {
    assert.deepEqual(planFor([item("1", "domain")], models(2)), []);
  });

  it("expects domain visibility work under the exact-target v2 policy", () => {
    const expected = buildExpectedProviderExecutionPlan({
      run: { ...run("processing"), promptPolicyVersion: "geo-prompt-policy-v2-exact-target" },
      items: [item("1", "domain")],
      providerModels: models(2)
    });
    assert.equal(expected.length, 2);
    assert.ok(expected.every((entry) => entry.promptType === "visibility"));
  });

  it("deduplicates repeated provider/model rows", () => {
    const duplicate = models(1)[0]!;
    assert.equal(
      planFor([item("1", "category")], [duplicate, duplicate]).length,
      3
    );
  });

  it("rejects unsupported frozen prompt-policy versions", () => {
    assert.throws(
      () =>
        buildExpectedProviderExecutionPlan({
          run: {
            ...run("processing"),
            promptPolicyVersion: "unknown-policy"
          },
          items: [item("1", "category")],
          providerModels: models(1)
        }),
      /Unsupported frozen prompt policy/
    );
  });

  it("marks diagnostics non-scoring and visibility/ranking scoring", () => {
    const plan = planFor([item("1", "product")], models(1));
    const flags = new Map(
      plan.map((entry) => [entry.promptType, entry.requiresScoring])
    );
    assert.equal(flags.get("visibility"), true);
    assert.equal(flags.get("ranking"), true);
    assert.equal(flags.get("competitor"), false);
    assert.equal(flags.get("price_range"), false);
    assert.equal(flags.get("pros_cons"), false);
  });
});

describe("expected/materialized execution reconciliation", () => {
  it("matches an exact provider job tuple", () => {
    const expected = expectedOne("visibility");
    const result = reconcile([expected], [
      materialization(expected, { provider_job_id: "30" })
    ]);
    assert.equal(result[0]!.providerJobId, "30");
  });

  it("identifies missing llm_run", () => {
    const result = reconcile([expectedOne("visibility")], []);
    assert.equal(result[0]!.missing?.missingStage, "llm_run");
  });

  it("identifies missing prompt_job after an LLM run", () => {
    const expected = expectedOne("visibility");
    const result = reconcile([expected], [
      materialization(expected, {
        prompt_job_id: null,
        prompt_type: null,
        provider_job_id: null,
        provider: null,
        model: null
      })
    ]);
    assert.equal(result[0]!.missing?.missingStage, "prompt_job");
  });

  it("identifies missing provider_job after a prompt", () => {
    const expected = expectedOne("visibility");
    const result = reconcile([expected], [
      materialization(expected, {
        provider_job_id: null,
        provider: null,
        model: null
      })
    ]);
    assert.equal(result[0]!.missing?.missingStage, "provider_job");
  });

  it("does not let an unrelated provider job satisfy an expected tuple", () => {
    const expected = expectedOne("visibility");
    const unrelated = materialization(expected, {
      provider: "gemini",
      model: "gemini-1.5-flash"
    });
    const result = reconcile([expected], [unrelated]);
    assert.equal(result[0]!.providerJobId, null);
    assert.equal(result[0]!.missing?.missingStage, "provider_job");
  });

  it("treats a valid diagnostic as terminal without a score", () => {
    const expected = expectedOne("competitor");
    const result = reconcile([expected], [
      materialization(expected, {
        result_status: "valid",
        context_validation_status: "valid"
      })
    ]);
    assert.equal(result[0]!.executionState, "valid_diagnostic");
  });

  it("keeps valid score-bearing evidence pending without a score", () => {
    const expected = expectedOne("visibility");
    const result = reconcile([expected], [
      materialization(expected, {
        result_status: "valid",
        context_validation_status: "valid"
      })
    ]);
    assert.equal(result[0]!.executionState, "valid_score_pending");
  });

  it("makes exhausted scoring a terminal gap", () => {
    const expected = expectedOne("ranking");
    const result = reconcile([expected], [
      materialization(expected, {
        result_status: "valid",
        context_validation_status: "valid",
        scoring_failure_code: "SCORING_EXHAUSTED"
      })
    ]);
    assert.equal(result[0]!.executionState, "permanent_scoring_failure");
  });
});

describe("exact report lifecycle", () => {
  const lifecycle = (
    runStatus: AnalysisExecutionStatus,
    states: ReconciledExecutionState[],
    businessEmptyReason:
      | "no_matching_category"
      | "no_applicable_analysis_item"
      | null = null
  ) =>
    determineReportLifecycle({
      runStatus,
      coverage: calculateExactCoverage(states.map(executionWithState)),
      businessEmptyReason
    });

  it("classifies a failed zero-record run as failed_empty", () => {
    assert.equal(
      lifecycle("failed", Array(5).fill("missing_before_fan_out")),
      "failed_empty"
    );
  });

  it("classifies a cancelled zero-record run as cancelled_empty", () => {
    assert.equal(
      lifecycle("cancelled", Array(5).fill("missing_before_fan_out")),
      "cancelled_empty"
    );
  });

  it("does not infer cancellation from zero records", () => {
    assert.notEqual(
      lifecycle("failed", Array(5).fill("missing_before_fan_out")),
      "cancelled_empty"
    );
  });

  it("makes terminal missing-before-fan-out a completed gap", () => {
    const states = [
      ...Array(9).fill("valid_scored"),
      "missing_before_fan_out"
    ] as ReconciledExecutionState[];
    const coverage = calculateExactCoverage(states.map(executionWithState));
    assert.equal(lifecycle("completed", states), "completed_with_gaps");
    assert.equal(coverage.missingBeforeFanOut, 1);
  });

  it("completes when all expected work is valid", () => {
    assert.equal(
      lifecycle("completed", ["valid_scored", "valid_diagnostic"]),
      "completed"
    );
  });

  it("treats valid evidence plus invalid evidence as completed_with_gaps", () => {
    assert.equal(
      lifecycle("partial_success", ["valid_scored", "invalid"]),
      "completed_with_gaps"
    );
  });

  it("uses partial for usable evidence with pending work", () => {
    assert.equal(
      lifecycle("processing", ["valid_scored", "pending"]),
      "partial"
    );
  });

  it("uses budget_paused_partial when only paused work remains", () => {
    assert.equal(
      lifecycle("paused_budget", ["valid_scored", "budget_paused"]),
      "budget_paused_partial"
    );
  });

  it("uses cancelled_partial when a cancelled run has usable evidence", () => {
    assert.equal(
      lifecycle("cancelled", ["valid_scored", "cancelled"]),
      "cancelled_partial"
    );
  });

  for (const reason of [
    "no_matching_category",
    "no_applicable_analysis_item"
  ] as const) {
    it(`preserves ${reason} as completed_empty`, () => {
      assert.equal(lifecycle("completed", [], reason), "completed_empty");
    });
  }

  it("keeps a valid negative ranking score of zero as usable, non-gap evidence", () => {
    const execution = executionWithState("valid_scored");
    execution.expected = expectedOne("ranking");
    execution.actual = materialization(execution.expected, {
      provider_score_id: "50",
      score: "0.0000",
      metric_type: "ranking"
    });
    execution.providerScoreId = "50";
    const report = buildMultiProviderReport(
      "9",
      [execution],
      "completed"
    );
    assert.equal(report.lifecycleState, "completed");
    assert.equal(report.counts.validScored, 1);
    assert.equal(report.overallDimensions.averageRankingScore, 0);
  });

  it("averages authoritative model-path GEO scores instead of raw metrics", () => {
    const visibilityExpected = expectedOne("visibility");
    const rankingExpected = expectedOne("ranking");
    const visibility = reconcile(
      [visibilityExpected],
      [
        materialization(visibilityExpected, {
          provider_score_id: "51",
          metric_type: "visibility",
          scoring_version: "geo-scoring-v2",
          score: "100"
        })
      ]
    )[0]!;
    const ranking = reconcile(
      [rankingExpected],
      [
        materialization(rankingExpected, {
          prompt_job_id: "21",
          provider_job_id: "31",
          provider_result_id: "41",
          provider_score_id: "52",
          metric_type: "ranking",
          scoring_version: "geo-scoring-v2",
          score: "0"
        })
      ]
    )[0]!;
    const report = buildMultiProviderReport(
      "9",
      [visibility, ranking],
      "completed"
    );
    assert.equal(report.modelPathScores[0]?.geoScore, 60);
    assert.equal(report.providerModelComparison[0]?.averageGeoScore, 60);
  });

  it("uses null ratios for zero expected-work denominators", () => {
    const coverage = calculateExactCoverage([]);
    assert.equal(coverage.materializationCoverage, null);
    assert.equal(coverage.terminalCoverage, null);
    assert.equal(coverage.usableEvidenceCoverage, null);
    assert.equal(coverage.scoreBearingCoverage, null);
  });

  it("exposes reused discovery semantically without leaking its request id", () => {
    const report = buildMultiProviderReport(
      "9",
      [],
      "completed",
      {
        discovery_status: "completed",
        discovery_coverage: {},
        reused_from_pre_analysis_request_id: "12345",
        input_tokens: null,
        output_tokens: null,
        cost_micros: null,
        estimated_input_tokens: null,
        estimated_output_tokens: null,
        estimated_cost_micros: null
      }
    );
    const serialized = JSON.stringify(report);
    assert.equal(report.methodology.reused, true);
    assert.equal(report.hierarchyDiscovery?.reused, true);
    assert.equal(serialized.includes("12345"), false);
    assert.equal(serialized.includes("reusedFromPreAnalysisRequestId"), false);
  });
});

function planFor(
  items: ExpectedPlanItem[],
  providerModels: ExpectedPlanProviderModel[]
) {
  return buildExpectedProviderExecutionPlan({
    run: run("processing"),
    items,
    providerModels
  });
}

function run(status: AnalysisExecutionStatus) {
  return {
    analysisRunId: "9",
    status,
    promptDepth: "medium" as const,
    promptPolicyVersion: "geo-prompt-policy-v1"
  };
}

function item(
  id: string,
  targetLevel: EntityPathType,
  itemOrdinal = 0
): ExpectedPlanItem {
  return {
    analysisRunItemId: id,
    entityPathId: `${100 + Number(id)}`,
    targetLevel,
    categoryId: targetLevel === "domain" ? null : "10",
    categoryName: targetLevel === "domain" ? null : "Software",
    itemOrdinal,
    status: "processing"
  };
}

function models(count: number): ExpectedPlanProviderModel[] {
  const values: Array<[ProviderName, string]> = [
    ["openai", "gpt-4o-mini"],
    ["gemini", "gemini-1.5-flash"],
    ["claude", "claude-3-5-sonnet"]
  ];
  return values.slice(0, count).map(([provider, model], ordinal) => ({
    provider,
    model,
    modelProfileVersion: "profile-v1",
    ordinal
  }));
}

function expectedOne(promptType: PromptType) {
  return planFor([item("1", "product")], models(1)).find(
    (entry) => entry.promptType === promptType
  )!;
}

function reconcile(
  expected: ExpectedProviderExecution[],
  materialized: ReportMaterializationRecord[]
) {
  return reconcileExpectedProviderExecutions({
    expected,
    materialized,
    runStatus: "completed"
  });
}

function materialization(
  expected: ExpectedProviderExecution,
  overrides: Partial<ReportMaterializationRecord> = {}
): ReportMaterializationRecord {
  return {
    analysis_run_item_id: expected.analysisRunItemId,
    item_ordinal: expected.itemOrdinal,
    item_status: "completed",
    entity_path_id: expected.entityPathId,
    category_id: expected.categoryId,
    category_name: expected.categoryName,
    llm_run_id: "10",
    llm_run_status: "completed",
    llm_error_code: null,
    prompt_job_id: "20",
    prompt_type: expected.promptType,
    prompt_depth: expected.promptDepth,
    business_prompt_version: `${expected.promptType}-v1`,
    response_contract_version: `${expected.promptType}-response-v1`,
    prompt_job_status: "succeeded",
    prompt_error_code: null,
    provider_job_id: "30",
    provider: expected.provider,
    model: expected.model,
    provider_job_status: "succeeded",
    provider_error_code: null,
    provider_result_id: "40",
    result_status: "valid",
    context_validation_status: "valid",
    validated_response: {
      result: { confidence: 0.75 },
      evidence: [{ confidence: 0.75 }]
    },
    validation_errors: [],
    provider_score_id: null,
    metric_type: null,
    scoring_version: null,
    score: null,
    score_components: null,
    scoring_failure_code: null,
    input_tokens: 10,
    output_tokens: 5,
    cost_micros: "1",
    ...overrides
  };
}

function executionWithState(
  state: ReconciledExecutionState,
  index = 0
): ReconciledProviderExecution {
  const expected = {
    ...expectedOne(index % 2 === 0 ? "visibility" : "competitor"),
    analysisRunItemId: `${index + 1}`,
    identity: `identity-${index}`
  };
  return {
    expected,
    llmRunId: state === "missing_before_fan_out" ? null : "10",
    promptJobId: state === "missing_before_fan_out" ? null : "20",
    providerJobId: state === "missing_before_fan_out" ? null : "30",
    providerResultId:
      state.startsWith("valid") || state === "invalid" ? "40" : null,
    providerScoreId: state === "valid_scored" ? "50" : null,
    materializationStage:
      state === "valid_scored" ? "provider_score" : "provider_job",
    executionState: state,
    missing:
      state === "missing_before_fan_out"
        ? {
            analysisRunItemId: expected.analysisRunItemId,
            entityPathId: expected.entityPathId,
            categoryId: expected.categoryId,
            promptType: expected.promptType,
            provider: expected.provider,
            model: expected.model,
            missingStage: "provider_job",
            reason: "expected_but_not_materialized"
          }
        : null,
    actual: null
  };
}
