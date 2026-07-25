import type { JsonObject, PromptType } from "../types/database.types.js";
import {
  BASIC_REPORT_VERSION,
  SCORING_VERSION,
  type BasicReportData,
  type ReportScoreRecord
} from "../scoring/score.types.js";
import { ReportRepository } from "./report.repository.js";

export type ReportAggregationResult =
  | { outcome: "not_ready"; reportId: null }
  | { outcome: "completed"; reportId: string; created: boolean };

export class ReportAggregationService {
  constructor(private readonly reports: ReportRepository) {}

  async createIfReady(
    analysisRunId: string
  ): Promise<ReportAggregationResult> {
    const readiness = await this.reports.readiness(
      analysisRunId,
      SCORING_VERSION
    );
    const promptCount = Number(readiness.prompt_count);
    const scoredPromptCount = Number(readiness.scored_prompt_count);
    if (promptCount === 0 || scoredPromptCount !== promptCount) {
      return { outcome: "not_ready", reportId: null };
    }

    const scores = await this.reports.scoreRecords(
      analysisRunId,
      SCORING_VERSION
    );
    if (scores.length !== promptCount) {
      throw new Error(
        "Ready report did not resolve exactly one score per prompt job"
      );
    }
    const reportData = buildBasicReport(analysisRunId, scores);
    const report = await this.reports.createOrReuse({
      analysisRunId,
      reportVersion: BASIC_REPORT_VERSION,
      reportData,
      renderedText: renderBasicReport(reportData)
    });
    await this.reports.markRunCompleted(analysisRunId);
    return {
      outcome: "completed",
      reportId: report.row.report_id,
      created: report.created
    };
  }
}

export function buildBasicReport(
  analysisRunId: string,
  scores: ReportScoreRecord[]
): BasicReportData {
  const grouped = new Map<PromptType, ReportScoreRecord[]>();
  for (const score of scores) {
    const existing = grouped.get(score.prompt_type) ?? [];
    existing.push(score);
    grouped.set(score.prompt_type, existing);
  }
  const breakdown = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([promptType, records]) => {
      const score = round(
        records.reduce((total, record) => total + Number(record.score), 0) /
          records.length
      );
      return {
        promptType,
        score,
        summary: summaryFor(promptType, score),
        evidenceCount: records.reduce(
          (total, record) =>
            total + evidenceCount(record.parsed_response),
          0
        )
      };
    });
  const overallScore = round(
    scores.reduce((total, score) => total + Number(score.score), 0) /
      scores.length
  );
  const providerModels = [
    ...new Map(
      scores.map((score) => [
        `${score.provider}:${score.model}`,
        { provider: score.provider, model: score.model }
      ])
    ).values()
  ].sort((left, right) =>
    `${left.provider}:${left.model}`.localeCompare(
      `${right.provider}:${right.model}`
    )
  );
  const usage = scores.reduce(
    (total, score) => ({
      inputTokens: total.inputTokens + (score.input_tokens ?? 0),
      outputTokens: total.outputTokens + (score.output_tokens ?? 0),
      costMicros: total.costMicros + Number(score.cost_micros ?? 0)
    }),
    { inputTokens: 0, outputTokens: 0, costMicros: 0 }
  );

  return {
    analysisRunId,
    reportType: "basic_report",
    reportVersion: BASIC_REPORT_VERSION,
    overallScore,
    summary: `Backend-computed GEO score is ${overallScore} across ${scores.length} provider evidence records.`,
    breakdown,
    providerModels,
    usage
  };
}

function renderBasicReport(report: BasicReportData) {
  const lines = report.breakdown.map(
    (entry) => `${entry.promptType}: ${entry.score} - ${entry.summary}`
  );
  return [report.summary, ...lines].join("\n");
}

function evidenceCount(response: JsonObject) {
  return Array.isArray(response.evidence) ? response.evidence.length : 0;
}

function summaryFor(promptType: PromptType, score: number) {
  const level = score >= 75 ? "strong" : score >= 60 ? "moderate" : "limited";
  const labels: Record<PromptType, string> = {
    visibility: "visibility",
    competitor: "competitor presence",
    ranking: "ranking",
    price_range: "price positioning",
    pros_cons: "strength and weakness"
  };
  return `Backend interpretation indicates ${level} ${labels[promptType]} evidence.`;
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
