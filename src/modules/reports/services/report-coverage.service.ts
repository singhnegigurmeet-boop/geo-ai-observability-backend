import type { AnalysisExecutionStatus } from "../../../common/types/database.types.js";
import type {
  MissingExpectedExecution,
  ReconciledExecutionState,
  ReconciledProviderExecution
} from "./execution-reconciliation.service.js";

export const MAX_MISSING_EXPECTED_EXECUTIONS = 500;

export type ReportLifecycleState =
  | "partial"
  | "budget_paused_partial"
  | "completed"
  | "completed_with_gaps"
  | "failed_empty"
  | "completed_empty"
  | "cancelled_partial"
  | "cancelled_empty";

export function calculateExactCoverage(
  reconciled: readonly ReconciledProviderExecution[]
) {
  const count = (state: ReconciledExecutionState) =>
    reconciled.filter((execution) => execution.executionState === state).length;
  const expectedProviderJobs = reconciled.length;
  const materializedProviderJobs = reconciled.filter(
    (execution) => execution.providerJobId !== null
  ).length;
  const validScored = count("valid_scored");
  const validDiagnostic = count("valid_diagnostic");
  const invalid = count("invalid");
  const technicalFailure = count("technical_failure");
  const budgetPaused = count("budget_paused");
  const cancelled = count("cancelled");
  const missingBeforeFanOut = count("missing_before_fan_out");
  const permanentScoringFailure = count("permanent_scoring_failure");
  const validScorePending = count("valid_score_pending");
  const pending = count("pending") + validScorePending;
  const expectedScoreBearingExecutions = reconciled.filter(
    (execution) => execution.expected.requiresScoring
  ).length;
  const terminalExpectedExecutions = reconciled.filter((execution) =>
    isTerminalExecution(execution.executionState)
  ).length;
  const usableEvidence = validScored + validDiagnostic;
  const materializationCoverage = ratio(
    materializedProviderJobs,
    expectedProviderJobs
  );
  const terminalCoverage = ratio(
    terminalExpectedExecutions,
    expectedProviderJobs
  );
  const usableEvidenceCoverage = ratio(
    usableEvidence,
    expectedProviderJobs
  );
  const scoreBearingCoverage = ratio(
    validScored,
    expectedScoreBearingExecutions
  );
  return {
    expectedProviderJobs,
    materializedProviderJobs,
    validScored,
    validDiagnostic,
    invalid,
    technicalFailure,
    budgetPaused,
    cancelled,
    missingBeforeFanOut,
    permanentScoringFailure,
    pending,
    validScorePending,
    expectedScoreBearingExecutions,
    terminalExpectedExecutions,
    materializationCoverage,
    terminalCoverage,
    usableEvidenceCoverage,
    scoreBearingCoverage,
    // Compatibility aliases retained for the existing report contract.
    expected: expectedProviderJobs,
    materialized: materializedProviderJobs,
    missingMaterialization: missingBeforeFanOut,
    nonterminal: pending,
    scored: validScored,
    failed: technicalFailure,
    pausedBudget: budgetPaused,
    completionPercentage:
      terminalCoverage === null ? 100 : round(terminalCoverage * 100)
  };
}

export function determineReportLifecycle(input: {
  runStatus: AnalysisExecutionStatus;
  coverage: ReturnType<typeof calculateExactCoverage>;
  businessEmptyReason:
    | "no_matching_category"
    | "no_applicable_analysis_item"
    | null;
}): ReportLifecycleState {
  const usable =
    input.coverage.validScored + input.coverage.validDiagnostic;
  if (input.runStatus === "cancelled") {
    return usable > 0 ? "cancelled_partial" : "cancelled_empty";
  }
  if (
    input.coverage.expectedProviderJobs === 0 &&
    input.businessEmptyReason !== null
  ) {
    return "completed_empty";
  }
  if (input.runStatus === "failed" && usable === 0) {
    return "failed_empty";
  }
  if (input.coverage.pending > 0) {
    return usable > 0 ? "partial" : "partial";
  }
  if (input.coverage.budgetPaused > 0) {
    return usable > 0 ? "budget_paused_partial" : "failed_empty";
  }
  if (usable === 0) {
    return "failed_empty";
  }
  return hasMaterialGaps(input.coverage)
    ? "completed_with_gaps"
    : "completed";
}

export function missingExpectedExecutionDetails(
  reconciled: readonly ReconciledProviderExecution[]
) {
  const all = reconciled
    .filter(
      (
        execution
      ): execution is ReconciledProviderExecution & {
        missing: MissingExpectedExecution;
      } => execution.missing !== null
    )
    .sort(compareMissingExecution)
    .map((execution) => execution.missing);
  const executions = all.slice(0, MAX_MISSING_EXPECTED_EXECUTIONS);
  return {
    totalMissingCount: all.length,
    returnedMissingCount: executions.length,
    truncated: executions.length < all.length,
    executions
  };
}

export function categoryCoverage(
  reconciled: readonly ReconciledProviderExecution[]
) {
  return groupedCoverage(
    reconciled,
    (execution) =>
      execution.expected.categoryId ??
      `path:${execution.expected.entityPathId}`
  ).map((group) => {
    const coverage = calculateExactCoverage(group);
    return {
      categoryId: group[0]!.expected.categoryId,
      categoryName: group[0]!.expected.categoryName,
      expectedProviderExecutions: coverage.expectedProviderJobs,
      materializedProviderExecutions: coverage.materializedProviderJobs,
      validScored: coverage.validScored,
      validDiagnostic: coverage.validDiagnostic,
      gaps: materialGapCount(coverage),
      pending: coverage.pending,
      coverage: coverage.usableEvidenceCoverage
    };
  });
}

export function providerModelCoverage(
  reconciled: readonly ReconciledProviderExecution[]
) {
  return groupedCoverage(
    reconciled,
    (execution) =>
      `${execution.expected.provider}\u0000${execution.expected.model}`
  )
    .map((group) => {
      const coverage = calculateExactCoverage(group);
      return {
        provider: group[0]!.expected.provider,
        model: group[0]!.expected.model,
        modelProfileVersion: group[0]!.expected.modelProfileVersion,
        expectedExecutions: coverage.expectedProviderJobs,
        materializedExecutions: coverage.materializedProviderJobs,
        validScored: coverage.validScored,
        validDiagnostic: coverage.validDiagnostic,
        invalid: coverage.invalid,
        technicalFailures: coverage.technicalFailure,
        budgetPaused: coverage.budgetPaused,
        cancelled: coverage.cancelled,
        missingBeforeFanOut: coverage.missingBeforeFanOut,
        permanentScoringFailure: coverage.permanentScoringFailure,
        pending: coverage.pending
      };
    })
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model)
    );
}

export function reportIsFinal(input: {
  runStatus: AnalysisExecutionStatus;
  lifecycleState: ReportLifecycleState;
  coverage: ReturnType<typeof calculateExactCoverage>;
}) {
  return (
    isTerminalRun(input.runStatus) &&
    input.coverage.pending === 0 &&
    input.coverage.budgetPaused === 0 &&
    ![
      "partial",
      "budget_paused_partial"
    ].includes(input.lifecycleState)
  );
}

export function isTerminalRun(status: AnalysisExecutionStatus) {
  return (
    status === "completed" ||
    status === "partial_success" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function isTerminalExecution(state: ReconciledExecutionState) {
  return (
    state !== "pending" &&
    state !== "valid_score_pending" &&
    state !== "budget_paused"
  );
}

function hasMaterialGaps(
  coverage: ReturnType<typeof calculateExactCoverage>
) {
  return materialGapCount(coverage) > 0;
}

function materialGapCount(
  coverage: ReturnType<typeof calculateExactCoverage>
) {
  return (
    coverage.invalid +
    coverage.technicalFailure +
    coverage.cancelled +
    coverage.missingBeforeFanOut +
    coverage.permanentScoringFailure
  );
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? null : round(numerator / denominator);
}

function groupedCoverage(
  reconciled: readonly ReconciledProviderExecution[],
  keyFor: (execution: ReconciledProviderExecution) => string
) {
  const groups = new Map<string, ReconciledProviderExecution[]>();
  for (const execution of reconciled) {
    const key = keyFor(execution);
    const group = groups.get(key) ?? [];
    group.push(execution);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function compareMissingExecution(
  left: ReconciledProviderExecution,
  right: ReconciledProviderExecution
) {
  return (
    left.expected.itemOrdinal - right.expected.itemOrdinal ||
    compareDatabaseIds(
      left.expected.analysisRunItemId,
      right.expected.analysisRunItemId
    ) ||
    left.expected.promptOrdinal - right.expected.promptOrdinal ||
    left.expected.provider.localeCompare(right.expected.provider) ||
    left.expected.model.localeCompare(right.expected.model)
  );
}

function compareDatabaseIds(left: string, right: string) {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
