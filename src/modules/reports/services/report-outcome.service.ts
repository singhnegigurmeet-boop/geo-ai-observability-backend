import type { JsonObject, ReportStatus } from "../../../common/types/database.types.js";
import { MULTI_PROVIDER_REPORT_VERSION } from "../../scoring/types/score.types.js";
import { ReportRepository } from "../repositories/report.repository.js";

type EmptyOutcomeInput = {
  analysisRunId: string;
  lifecycleState: "completed_empty" | "cancelled_empty";
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
  }) {
    return this.createEmpty({
      analysisRunId: input.analysisRunId,
      lifecycleState: "completed_empty",
      status: "completed",
      summary: "No eligible analysis targets were configured for this path.",
      details: {
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

  private createEmpty(input: EmptyOutcomeInput) {
    const reportData = {
      analysisRunId: input.analysisRunId,
      reportType: "multi_provider_report",
      reportVersion: MULTI_PROVIDER_REPORT_VERSION,
      lifecycleState: input.lifecycleState,
      final: true,
      resumePossible: false,
      summary: input.summary,
      ...(input.details ?? {}),
      counts: {
        expected: 0,
        nonterminal: 0,
        scored: 0,
        invalid: 0,
        failed: 0,
        pausedBudget: 0,
        cancelled: 0,
        completionPercentage: 100
      },
      providerResults: [],
      promptScores: [],
      breakdown: [],
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 }
    } satisfies JsonObject;
    return this.reports.createRevision({
      analysisRunId: input.analysisRunId,
      reportVersion: MULTI_PROVIDER_REPORT_VERSION,
      status: input.status,
      reportData,
      renderedText: input.summary
    });
  }
}
