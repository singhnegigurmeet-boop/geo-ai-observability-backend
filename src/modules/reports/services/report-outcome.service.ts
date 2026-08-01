import type { JsonObject, ReportStatus } from "../../../common/types/database.types.js";
import {
  MULTI_PROVIDER_REPORT_VERSION,
  SCORING_VERSION
} from "../../scoring/types/score.types.js";
import { ReportRepository } from "../repositories/report.repository.js";

type EmptyOutcomeInput = {
  analysisRunId: string;
  lifecycleState: "completed_empty" | "cancelled_empty" | "failed_empty";
  status: ReportStatus;
  summary: string;
  details?: JsonObject;
};

/**
 * Owns immutable reports for terminal business outcomes that have no provider
 * execution records. Provider-backed snapshots remain owned by
 * ReportAggregationService.
 */
export class ReportOutcomeService {
  constructor(private readonly reports: ReportRepository) {}

  createCompletedEmpty(input: {
    analysisRunId: string;
    startingEntityPathId: string;
    nextAction: string;
    reason?: "no_matching_category" | "no_applicable_analysis_item";
    summary?: string;
  }) {
    return this.createEmpty({
      analysisRunId: input.analysisRunId,
      lifecycleState: "completed_empty",
      status: "completed",
      summary:
        input.summary ??
        "No eligible analysis targets were configured for this path.",
      details: {
        reason: input.reason ?? "no_applicable_analysis_item",
        startingEntityPathId: input.startingEntityPathId,
        expandedTargetCount: 0,
        nextAction: input.nextAction
      }
    });
  }

  createCancelledEmpty(analysisRunId: string) {
    return this.createEmpty({
      analysisRunId,
      lifecycleState: "cancelled_empty",
      status: "failed",
      summary: "The analysis was cancelled before provider execution began."
    });
  }

  createFailedEmpty(input: {
    analysisRunId: string;
    errorCode: string;
    summary: string;
  }) {
    return this.createEmpty({
      analysisRunId: input.analysisRunId,
      lifecycleState: "failed_empty",
      status: "failed",
      summary: input.summary,
      details: { errorCode: input.errorCode }
    });
  }

  private async createEmpty(input: EmptyOutcomeInput) {
    const [methodology, discovery] = await Promise.all([
      this.reports.methodologyContext(input.analysisRunId),
      this.reports.discoveryRecord(input.analysisRunId)
    ]);
    const counts = {
      expectedProviderJobs: 0,
      materializedProviderJobs: 0,
      validScored: 0,
      validDiagnostic: 0,
      invalid: 0,
      technicalFailure: 0,
      budgetPaused: 0,
      cancelled: 0,
      missingBeforeFanOut: 0,
      permanentScoringFailure: 0,
      pending: 0,
      validScorePending: 0,
      expectedScoreBearingExecutions: 0,
      terminalExpectedExecutions: 0,
      materializationCoverage: null,
      terminalCoverage: null,
      usableEvidenceCoverage: null,
      scoreBearingCoverage: null,
      expected: 0,
      materialized: 0,
      missingMaterialization: 0,
      nonterminal: 0,
      scored: 0,
      failed: 0,
      pausedBudget: 0,
      completionPercentage: 100
    };
    const reportData = {
      analysisRunId: input.analysisRunId,
      reportType: "multi_provider_report",
      reportVersion: MULTI_PROVIDER_REPORT_VERSION,
      lifecycleState: input.lifecycleState,
      final: true,
      resumePossible: false,
      summary: input.summary,
      methodology: {
        analysisRunId: input.analysisRunId,
        domain: methodology?.domain ?? null,
        requestedCategoryMode:
          methodology?.category_selection_mode ?? null,
        requestedCategoryIds:
          methodology?.requested_category_ids ?? [],
        matchedCategories: methodology?.matched_categories ?? [],
        promptDepth: methodology?.prompt_depth ?? null,
        promptPolicyVersion: methodology?.prompt_policy_version ?? null,
        selectedProviderModels:
          methodology?.selected_provider_models ?? [],
        discoveryStatus: discovery?.discovery_status ?? null,
        discoveryCoverage: discovery?.discovery_coverage ?? null,
        reused: discovery?.reused_from_pre_analysis_request_id !== null &&
          discovery?.reused_from_pre_analysis_request_id !== undefined,
        scoringVersion: SCORING_VERSION,
        reportVersion: MULTI_PROVIDER_REPORT_VERSION,
        createdAt: methodology?.created_at ?? null,
        completedAt: methodology?.completed_at ?? null
      },
      ...(input.details ?? {}),
      counts,
      coverage: counts,
      missingExpectedExecutions: {
        totalMissingCount: 0,
        returnedMissingCount: 0,
        truncated: false,
        executions: []
      },
      categoryCoverage: [],
      providerResults: [],
      promptScores: [],
      modelPathScores: [],
      categoryScores: [],
      categoryBreakdown: [],
      breakdown: [],
      providerModelComparison: [],
      visibility: [],
      ranking: [],
      competitors: [],
      price: [],
      prosAndCons: [],
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 }
    } satisfies JsonObject;
    return await this.reports.createRevision({
      analysisRunId: input.analysisRunId,
      reportVersion: MULTI_PROVIDER_REPORT_VERSION,
      status: input.status,
      reportData,
      renderedText: input.summary
    });
  }
}
