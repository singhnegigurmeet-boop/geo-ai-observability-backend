import type {
  JsonObject,
  PromptType,
  ReportStatus
} from "../../../common/types/database.types.js";
import {
  MULTI_PROVIDER_REPORT_VERSION,
  SCORING_VERSION
} from "../../scoring/types/score.types.js";
import {
  ReportRepository,
  type ReportExecutionRecord
} from "../repositories/report.repository.js";

export type ReportAggregationResult =
  | { outcome: "not_ready"; reportId: null }
  | {
      outcome: "snapshot";
      reportId: string;
      revision: number;
      status: ReportStatus;
      lifecycleState: string;
      created: boolean;
    };

export class ReportAggregationService {
  constructor(private readonly reports: ReportRepository) {}

  async createIfReady(analysisRunId: string): Promise<ReportAggregationResult> {
    const run = await this.reports.lockRun(analysisRunId);
    if (!run) throw new Error(`Analysis run ${analysisRunId} does not exist`);
    const records = await this.reports.executionRecords(
      analysisRunId,
      SCORING_VERSION
    );
    if (records.length === 0) return { outcome: "not_ready", reportId: null };
    const data = buildMultiProviderReport(analysisRunId, records, run.status);
    if (data.counts.scored === 0 && data.counts.nonterminal > 0) {
      return { outcome: "not_ready", reportId: null };
    }
    const reportStatus: ReportStatus =
      data.lifecycleState === "partial" ||
      data.lifecycleState === "budget_paused_partial" ||
      data.lifecycleState === "cancelled_partial"
        ? "partial"
        : data.lifecycleState === "failed_empty" ||
            data.lifecycleState === "cancelled_empty"
          ? "failed"
          : "completed";
    const report = await this.reports.createRevision({
      analysisRunId,
      reportVersion: MULTI_PROVIDER_REPORT_VERSION,
      status: reportStatus,
      reportData: data,
      renderedText: renderReport(data)
    });
    if (data.counts.nonterminal === 0 && data.counts.pausedBudget === 0) {
      const finalRunStatus =
        data.counts.scored > 0
          ? data.counts.failed + data.counts.invalid + data.counts.cancelled > 0
            ? "partial_success"
            : "completed"
          : data.counts.cancelled === data.counts.expected
            ? "cancelled"
            : "failed";
      await this.reports.markRunFinal(analysisRunId, finalRunStatus);
    }
    return {
      outcome: "snapshot",
      reportId: report.row.report_id,
      revision: report.row.revision,
      status: report.row.status,
      lifecycleState: data.lifecycleState,
      created: report.created
    };
  }
}

export function buildMultiProviderReport(
  analysisRunId: string,
  records: ReportExecutionRecord[],
  runStatus: string
) {
  const nonterminal = records.filter(
    (record) =>
      record.provider_job_status === "pending" ||
      record.provider_job_status === "queued" ||
      record.provider_job_status === "processing" ||
      (record.result_status === "valid" && record.score === null)
  ).length;
  const scored = records.filter((record) => record.score !== null).length;
  const invalid = records.filter(
    (record) => record.result_status === "invalid"
  ).length;
  const failed = records.filter(
    (record) =>
      record.provider_job_status === "failed" &&
      record.result_status !== "invalid"
  ).length;
  const pausedBudget = records.filter(
    (record) => record.provider_job_status === "paused_budget"
  ).length;
  const cancelled = records.filter(
    (record) => record.provider_job_status === "cancelled"
  ).length;
  const lifecycleState =
    pausedBudget > 0
      ? scored > 0
        ? "budget_paused_partial"
        : "failed_empty"
      : runStatus === "cancelled" || cancelled === records.length
        ? scored > 0
          ? "cancelled_partial"
          : "cancelled_empty"
        : nonterminal > 0
          ? "partial"
          : scored === 0
            ? "failed_empty"
            : failed + invalid + cancelled > 0
              ? "completed_with_gaps"
              : "completed";

  const providerResults = records.map((record) => ({
    promptJobId: record.prompt_job_id,
    promptType: record.prompt_type,
    promptVersion: record.prompt_version,
    providerJobId: record.provider_job_id,
    provider: record.provider,
    model: record.model,
    state: record.provider_job_status,
    evidenceStatus: record.result_status ?? "missing",
    score: record.score === null ? null : Number(record.score),
    scoringVersion: record.scoring_version,
    errorCode: record.error_code,
    evidenceCount:
      record.parsed_response &&
      Array.isArray(record.parsed_response.evidence)
        ? record.parsed_response.evidence.length
        : 0,
    usage: {
      inputTokens: record.input_tokens ?? 0,
      outputTokens: record.output_tokens ?? 0,
      costMicros: Number(record.cost_micros ?? 0)
    }
  }));
  const prompts = new Map<string, ReportExecutionRecord[]>();
  for (const record of records) {
    const group = prompts.get(record.prompt_job_id) ?? [];
    group.push(record);
    prompts.set(record.prompt_job_id, group);
  }
  const promptScores = [...prompts.entries()].map(([promptJobId, group]) => {
    const validScores = group
      .filter((record) => record.score !== null)
      .map((record) => Number(record.score));
    return {
      promptJobId,
      promptType: group[0]!.prompt_type,
      promptVersion: group[0]!.prompt_version,
      score: validScores.length ? mean(validScores) : null,
      scoredProviders: validScores.length,
      expectedProviders: group.length
    };
  });
  const byType = new Map<PromptType, number[]>();
  for (const prompt of promptScores) {
    if (prompt.score === null) continue;
    const values = byType.get(prompt.promptType) ?? [];
    values.push(prompt.score);
    byType.set(prompt.promptType, values);
  }
  const breakdown = [...byType.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([promptType, scores]) => ({
      promptType,
      score: mean(scores),
      promptCount: scores.length
    }));
  const overallScores = promptScores
    .map((prompt) => prompt.score)
    .filter((score): score is number => score !== null);
  const counts = {
    expected: records.length,
    nonterminal,
    scored,
    invalid,
    failed,
    pausedBudget,
    cancelled,
    completionPercentage:
      records.length === 0
        ? 100
        : Math.round(((records.length - nonterminal) / records.length) * 10_000) /
          100
  };
  return {
    analysisRunId,
    reportType: "multi_provider_report",
    reportVersion: MULTI_PROVIDER_REPORT_VERSION,
    lifecycleState,
    final: nonterminal === 0 && pausedBudget === 0,
    resumePossible: false,
    summary: explanation(lifecycleState, counts),
    overallScore: overallScores.length ? mean(overallScores) : null,
    counts,
    promptScores,
    breakdown,
    providerResults,
    usage: providerResults.reduce(
      (total, record) => ({
        inputTokens: total.inputTokens + record.usage.inputTokens,
        outputTokens: total.outputTokens + record.usage.outputTokens,
        costMicros: total.costMicros + record.usage.costMicros
      }),
      { inputTokens: 0, outputTokens: 0, costMicros: 0 }
    )
  } satisfies JsonObject;
}

function explanation(
  state: string,
  counts: { expected: number; scored: number; nonterminal: number }
) {
  if (state === "budget_paused_partial") {
    return `Analysis stopped because the configured budget was reached. ${counts.scored} of ${counts.expected} provider executions have scored evidence.`;
  }
  if (state === "partial") {
    return `${counts.scored} of ${counts.expected} provider executions have scored evidence; ${counts.nonterminal} remain unfinished.`;
  }
  if (state === "failed_empty") {
    return "No valid scored provider evidence is available.";
  }
  if (state.startsWith("cancelled")) {
    return "Analysis was cancelled before provider execution completed.";
  }
  return `${counts.scored} of ${counts.expected} provider executions contributed scored evidence.`;
}

function renderReport(report: ReturnType<typeof buildMultiProviderReport>) {
  return [
    report.summary,
    ...report.breakdown.map(
      (entry) => `${entry.promptType}: ${entry.score}`
    )
  ].join("\n");
}

function mean(values: number[]) {
  return (
    Math.round(
      (values.reduce((total, value) => total + value, 0) / values.length) *
        10_000
    ) / 10_000
  );
}
