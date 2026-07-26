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
  type ClassificationReportRecord,
  type ReportMethodologyContext,
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
    const expected = await this.reports.expectedProviderExecutionCount(
      analysisRunId
    );
    const classification = await this.reports.classificationRecord(
      analysisRunId
    );
    const methodology = await this.reports.methodologyContext(analysisRunId);
    if (records.length === 0 && expected > 0 && !isTerminalRun(run.status)) {
      return { outcome: "not_ready", reportId: null };
    }
    const data = buildMultiProviderReport(
      analysisRunId,
      records,
      run.status,
      expected,
      classification,
      methodology
    );
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
      const finalizedMethodology =
        await this.reports.methodologyContext(analysisRunId);
      data.methodology.completedAt =
        finalizedMethodology?.completed_at ?? data.methodology.completedAt;
    }
    const report = await this.reports.createRevision({
      analysisRunId,
      reportVersion: MULTI_PROVIDER_REPORT_VERSION,
      status: reportStatus,
      reportData: data,
      renderedText: renderReport(data)
    });
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
  runStatus: string,
  expectedCoverage = records.length,
  classification: ClassificationReportRecord | null = null,
  methodology: ReportMethodologyContext | null = null
) {
  const missingMaterialization = Math.max(
    0,
    expectedCoverage - records.length
  );
  const nonterminal = records.filter(
    (record) =>
      record.provider_job_status === "pending" ||
      record.provider_job_status === "queued" ||
      record.provider_job_status === "processing" ||
      (isScoreBearing(record.prompt_type) &&
        record.result_status === "valid" &&
        record.score === null &&
        record.scoring_failure_code === null)
  ).length + (isTerminalRun(runStatus) ? 0 : missingMaterialization);
  const scored = records.filter((record) => record.score !== null).length;
  const invalid = records.filter(
    (record) => record.result_status === "invalid"
  ).length;
  const failed = records.filter(
    (record) =>
      record.provider_job_status === "failed" &&
      record.result_status !== "invalid"
  ).length +
    records.filter((record) => record.scoring_failure_code !== null).length;
  const pausedBudget = records.filter(
    (record) => record.provider_job_status === "paused_budget"
  ).length;
  const cancelled = records.filter(
    (record) => record.provider_job_status === "cancelled"
  ).length;
  const validDiagnostic = records.filter(
    (record) =>
      record.result_status === "valid" &&
      !isScoreBearing(record.prompt_type)
  ).length;
  const permanentScoringFailure = records.filter(
    (record) => record.scoring_failure_code !== null
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
    promptDepth: record.prompt_depth,
    businessPromptVersion: record.business_prompt_version,
    responseContractVersion: record.response_contract_version,
    entityPathId: record.entity_path_id,
    categoryId: record.category_id,
    categoryName: record.category_name,
    providerJobId: record.provider_job_id,
    provider: record.provider,
    model: record.model,
    state: record.provider_job_status,
    evidenceStatus: record.result_status ?? "missing",
    score: record.score === null ? null : Number(record.score),
    scoringVersion: record.scoring_version,
    errorCode: record.error_code,
    evidenceCount:
      record.validated_response &&
      Array.isArray(record.validated_response.evidence)
        ? record.validated_response.evidence.length
        : 0,
    confidence: responseConfidence(record.validated_response),
    validationErrors: record.validation_errors,
    scoringFailureCode: record.scoring_failure_code,
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
      promptDepth: group[0]!.prompt_depth,
      businessPromptVersion: group[0]!.business_prompt_version,
      responseContractVersion: group[0]!.response_contract_version,
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
  const modelPaths = buildModelPathScores(records);
  const categoryScores = buildCategoryScores(modelPaths);
  const overallScores = categoryScores
    .map((category) => category.geoScore)
    .filter((score): score is number => score !== null);
  const visibilityScores = records
    .filter((record) => record.metric_type === "visibility" && record.score !== null)
    .map((record) => Number(record.score));
  const rankingScores = records
    .filter((record) => record.metric_type === "ranking" && record.score !== null)
    .map((record) => Number(record.score));
  const confidences = records
    .map((record) => responseConfidence(record.validated_response))
    .filter((confidence): confidence is number => confidence !== null);
  const counts = {
    expected: expectedCoverage,
    materialized: records.length,
    missingMaterialization,
    nonterminal,
    scored,
    invalid,
    failed,
    validDiagnostic,
    permanentScoringFailure,
    pausedBudget,
    cancelled,
    completionPercentage:
      expectedCoverage === 0
        ? 100
        : Math.round(((expectedCoverage - nonterminal) / expectedCoverage) * 10_000) /
          100
  };
  const diagnosticSections = buildDiagnosticSections(records);
  const providerModelComparison = buildProviderModelComparison(records);
  const strongestCategory = [...categoryScores]
    .filter((category) => category.geoScore !== null)
    .sort((left, right) => right.geoScore! - left.geoScore!)[0] ?? null;
  const weakestCategory = [...categoryScores]
    .filter((category) => category.geoScore !== null)
    .sort((left, right) => left.geoScore! - right.geoScore!)[0] ?? null;
  const overallScore = overallScores.length ? mean(overallScores) : null;
  return {
    analysisRunId,
    reportType: "multi_provider_report",
    reportVersion: MULTI_PROVIDER_REPORT_VERSION,
    lifecycleState,
    final: nonterminal === 0 && pausedBudget === 0,
    resumePossible: false,
    summary: explanation(lifecycleState, counts),
    methodology: {
      analysisRunId,
      domain: methodology?.domain ?? null,
      requestedCategoryMode:
        methodology?.category_selection_mode ?? null,
      requestedCategoryIds: methodology?.requested_category_ids ?? [],
      matchedCategories: methodology?.matched_categories ?? [],
      classificationProvider: classification?.classifier_provider ?? null,
      classificationModel: classification?.classifier_model ?? null,
      classificationModelProfileVersion:
        classification?.model_profile_version ?? null,
      classificationPromptVersion: classification?.prompt_version ?? null,
      classificationResponseContractVersion:
        classification?.response_contract_version ?? null,
      promptDepth: methodology?.prompt_depth ?? null,
      promptPolicyVersion: methodology?.prompt_policy_version ?? null,
      selectedProviderModels:
        methodology?.selected_provider_models ?? [],
      businessPromptVersions: [
        ...new Set(records.map((record) => record.business_prompt_version))
      ].sort(),
      responseContractVersions: [
        ...new Set(records.map((record) => record.response_contract_version))
      ].sort(),
      scoringVersion: SCORING_VERSION,
      reportVersion: MULTI_PROVIDER_REPORT_VERSION,
      createdAt: methodology?.created_at ?? null,
      completedAt: methodology?.completed_at ?? null
    },
    overallScore,
    executiveSummary: {
      overallGeoScore: overallScore,
      scoreBand: scoreBand(overallScore),
      evidenceCoverage: counts.completionPercentage,
      providerAgreement: providerAgreement(modelPaths),
      strongestCategory,
      weakestCategory,
      majorVisibilityGaps: diagnosticSections.visibility.flatMap(
        (entry) => entry.visibilityGaps
      )
    },
    overallDimensions: {
      overallGeoScore: overallScore,
      averageVisibilityScore:
        visibilityScores.length ? mean(visibilityScores) : null,
      averageRankingScore: rankingScores.length ? mean(rankingScores) : null,
      averageConfidence: confidences.length ? mean(confidences) : null,
      coverage: counts.completionPercentage
    },
    counts,
    coverage: counts,
    promptScores,
    modelPathScores: modelPaths,
    categoryScores,
    categoryBreakdown: categoryScores,
    classification: classification
      ? {
          status: classification.classification_status,
          provider: classification.classifier_provider,
          model: classification.classifier_model,
          modelProfileVersion: classification.model_profile_version,
          promptVersion: classification.prompt_version,
          responseContractVersion:
            classification.response_contract_version,
          providerResultId: classification.provider_result_id,
          evidenceStatus: classification.result_status ?? "missing",
          matches:
            classification.validated_response &&
            Array.isArray(classification.validated_response.matches)
              ? classification.validated_response.matches
              : [],
          usage: {
            inputTokens: classification.input_tokens ?? 0,
            outputTokens: classification.output_tokens ?? 0,
            costMicros: Number(classification.cost_micros ?? 0)
          }
        }
      : null,
    breakdown,
    providerModelComparison,
    visibility: diagnosticSections.visibility,
    ranking: diagnosticSections.ranking,
    competitors: diagnosticSections.competitors,
    price: diagnosticSections.price,
    prosAndCons: diagnosticSections.prosAndCons,
    providerResults,
    usage: providerResults.reduce(
      (total, record) => ({
        inputTokens: total.inputTokens + record.usage.inputTokens,
        outputTokens: total.outputTokens + record.usage.outputTokens,
        costMicros: total.costMicros + record.usage.costMicros
      }),
      {
        inputTokens: classification?.input_tokens ?? 0,
        outputTokens: classification?.output_tokens ?? 0,
        costMicros: Number(classification?.cost_micros ?? 0)
      }
    ),
    usageAndCost: buildUsageAndCost(records, classification)
  } satisfies JsonObject;
}

function buildCategoryScores(
  modelPaths: ReturnType<typeof buildModelPathScores>
) {
  const groups = new Map<
    string,
    ReturnType<typeof buildModelPathScores>
  >();
  for (const path of modelPaths) {
    const key = path.categoryId ?? `path:${path.entityPathId}`;
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const scores = group
      .map((path) => path.geoScore)
      .filter((score): score is number => score !== null);
    return {
      categoryId: group[0]!.categoryId,
      categoryName: group[0]!.categoryName,
      geoScore: scores.length ? mean(scores) : null,
      availableModels: scores.length,
      expectedModels: group.length,
      modelCoverage:
        group.length === 0 ? 0 : round((scores.length / group.length) * 100)
    };
  });
}

function buildModelPathScores(records: ReportExecutionRecord[]) {
  const groups = new Map<string, ReportExecutionRecord[]>();
  for (const record of records) {
    const key = `${record.entity_path_id}\u0000${record.provider}\u0000${record.model}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const visibility = scoreFor(group, "visibility");
    const ranking = scoreFor(group, "ranking");
    const availableWeight =
      (visibility === null ? 0 : 0.6) + (ranking === null ? 0 : 0.4);
    const geoScore =
      availableWeight === 0
        ? null
        : round(
            ((visibility ?? 0) * 0.6 + (ranking ?? 0) * 0.4) /
              availableWeight
          );
    return {
      entityPathId: group[0]!.entity_path_id,
      categoryId: group[0]!.category_id,
      categoryName: group[0]!.category_name,
      provider: group[0]!.provider,
      model: group[0]!.model,
      visibilityScore: visibility,
      rankingScore: ranking,
      geoScore,
      partial: availableWeight > 0 && availableWeight < 1,
      availableMetricWeight: availableWeight,
      expectedMetricWeight: 1,
      metricCoverage: round(availableWeight * 100),
      missingMetricReasons: [
        ...(visibility === null ? [missingReason(group, "visibility")] : []),
        ...(ranking === null ? [missingReason(group, "ranking")] : [])
      ]
    };
  });
}

function scoreFor(records: ReportExecutionRecord[], type: PromptType) {
  const record = records.find((candidate) => candidate.prompt_type === type);
  return record?.score === null || record?.score === undefined
    ? null
    : Number(record.score);
}

function missingReason(records: ReportExecutionRecord[], type: PromptType) {
  const record = records.find((candidate) => candidate.prompt_type === type);
  if (!record) return `${type}:not_materialized`;
  if (record.result_status === "invalid") return `${type}:invalid`;
  if (record.scoring_failure_code) {
    return `${type}:scoring_failed:${record.scoring_failure_code}`;
  }
  return `${type}:${record.provider_job_status}`;
}

function buildProviderModelComparison(records: ReportExecutionRecord[]) {
  const groups = new Map<string, ReportExecutionRecord[]>();
  for (const record of records) {
    const key = `${record.provider}\u0000${record.model}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const scores = group
      .map((record) => record.score)
      .filter((score): score is string => score !== null)
      .map(Number);
    return {
      provider: group[0]!.provider,
      model: group[0]!.model,
      averageGeoScore: scores.length ? mean(scores) : null,
      validScoreBearingResults: group.filter(
        (record) =>
          record.result_status === "valid" &&
          isScoreBearing(record.prompt_type)
      ).length,
      validDiagnosticResults: group.filter(
        (record) =>
          record.result_status === "valid" &&
          !isScoreBearing(record.prompt_type)
      ).length,
      invalidResults: group.filter(
        (record) => record.result_status === "invalid"
      ).length,
      technicalFailures: group.filter(
        (record) =>
          record.provider_job_status === "failed" &&
          record.result_status !== "invalid"
      ).length,
      budgetPausedJobs: group.filter(
        (record) => record.provider_job_status === "paused_budget"
      ).length,
      cancelledJobs: group.filter(
        (record) => record.provider_job_status === "cancelled"
      ).length,
      pendingJobs: group.filter(
        (record) =>
          record.provider_job_status === "pending" ||
          record.provider_job_status === "queued" ||
          record.provider_job_status === "processing"
      ).length,
      usage: group.reduce(
        (total, record) => ({
          inputTokens: total.inputTokens + (record.input_tokens ?? 0),
          outputTokens: total.outputTokens + (record.output_tokens ?? 0),
          costMicros: total.costMicros + Number(record.cost_micros ?? 0)
        }),
        { inputTokens: 0, outputTokens: 0, costMicros: 0 }
      )
    };
  });
}

function buildUsageAndCost(
  records: ReportExecutionRecord[],
  classification: ClassificationReportRecord | null
) {
  const byCategory = new Map<
    string,
    { categoryId: string | null; inputTokens: number; outputTokens: number; costMicros: number }
  >();
  for (const record of records) {
    const key = record.category_id ?? `path:${record.entity_path_id}`;
    const current = byCategory.get(key) ?? {
      categoryId: record.category_id,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0
    };
    current.inputTokens += record.input_tokens ?? 0;
    current.outputTokens += record.output_tokens ?? 0;
    current.costMicros += Number(record.cost_micros ?? 0);
    byCategory.set(key, current);
  }
  return {
    normalExecution: records.reduce(
      (total, record) => ({
        inputTokens: total.inputTokens + (record.input_tokens ?? 0),
        outputTokens: total.outputTokens + (record.output_tokens ?? 0),
        costMicros: total.costMicros + Number(record.cost_micros ?? 0)
      }),
      { inputTokens: 0, outputTokens: 0, costMicros: 0 }
    ),
    classification: {
      inputTokens: classification?.input_tokens ?? 0,
      outputTokens: classification?.output_tokens ?? 0,
      costMicros: Number(classification?.cost_micros ?? 0)
    },
    byCategory: [...byCategory.values()]
  };
}

function providerAgreement(
  modelPaths: ReturnType<typeof buildModelPathScores>
) {
  const scores = modelPaths
    .map((path) => path.geoScore)
    .filter((score): score is number => score !== null);
  if (scores.length < 2) return null;
  return round(
    Math.max(0, 100 - (Math.max(...scores) - Math.min(...scores)))
  );
}

function buildDiagnosticSections(records: ReportExecutionRecord[]) {
  const visibility: Array<JsonObject> = [];
  const ranking: Array<JsonObject> = [];
  const competitors: Array<JsonObject> = [];
  const price: Array<JsonObject> = [];
  const prosAndCons: Array<JsonObject> = [];
  for (const record of records) {
    if (record.result_status !== "valid") continue;
    const result = responseResult(record.validated_response);
    if (!result) continue;
    const identity = {
      categoryId: record.category_id,
      categoryName: record.category_name,
      entityPathId: record.entity_path_id,
      provider: record.provider,
      model: record.model
    };
    if (record.prompt_type === "visibility") {
      visibility.push({
        ...identity,
        mentionLikelihood: jsonNumber(result.mention_likelihood),
        recommendationLikelihood: jsonNumber(
          result.recommendation_likelihood
        ),
        competitiveProminence: jsonNumber(result.competitive_prominence),
        queryIntents: jsonStringArray(result.query_intents),
        strengths: jsonStringArray(result.strengths),
        visibilityGaps: jsonStringArray(result.visibility_gaps),
        confidence: jsonNumber(result.confidence)
      });
    } else if (record.prompt_type === "ranking") {
      ranking.push({
        ...identity,
        requestedTopK: jsonNumber(result.requested_top_k),
        found: typeof result.found === "boolean" ? result.found : false,
        rankPosition: jsonNumber(result.rank_position),
        orderedCandidates: Array.isArray(result.ordered_candidates)
          ? result.ordered_candidates
          : [],
        mentionCount: jsonNumber(result.mention_count),
        confidence: jsonNumber(result.confidence)
      });
    } else if (record.prompt_type === "competitor") {
      competitors.push({
        ...identity,
        directCompetitors: Array.isArray(result.direct_competitors)
          ? result.direct_competitors
          : [],
        indirectCompetitors: Array.isArray(result.indirect_competitors)
          ? result.indirect_competitors
          : [],
        competitivePressure: jsonNumber(result.competitive_pressure),
        targetDifferentiation:
          typeof result.target_differentiation === "string"
            ? result.target_differentiation
            : "",
        confidence: jsonNumber(result.confidence)
      });
    } else if (record.prompt_type === "price_range") {
      price.push({
        ...identity,
        applicability:
          typeof result.applicability === "string"
            ? result.applicability
            : "unknown",
        currency:
          typeof result.currency === "string" ? result.currency : null,
        minimum: jsonNumber(result.minimum),
        maximum: jsonNumber(result.maximum),
        pricingBasis:
          typeof result.pricing_basis === "string"
            ? result.pricing_basis
            : "",
        uncertainty:
          typeof result.uncertainty === "string" ? result.uncertainty : "",
        confidence: jsonNumber(result.confidence)
      });
    } else if (record.prompt_type === "pros_cons") {
      prosAndCons.push({
        ...identity,
        pros: jsonStringArray(result.pros),
        cons: jsonStringArray(result.cons),
        bestFitFor: jsonStringArray(result.best_fit_for),
        poorFitFor: jsonStringArray(result.poor_fit_for),
        comparisonContext:
          typeof result.comparison_context === "string"
            ? result.comparison_context
            : "",
        confidence: jsonNumber(result.confidence)
      });
    }
  }
  return { visibility, ranking, competitors, price, prosAndCons };
}

function responseResult(response: JsonObject | null): JsonObject | null {
  const result = response?.result;
  return result && typeof result === "object" && !Array.isArray(result)
    ? result
    : null;
}

function jsonNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function scoreBand(score: number | null) {
  if (score === null) return "unscored";
  if (score >= 80) return "strong";
  if (score >= 60) return "moderate";
  if (score >= 40) return "weak";
  return "critical";
}

function responseConfidence(response: JsonObject | null) {
  const result = response?.result;
  return result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    typeof result.confidence === "number"
    ? result.confidence
    : null;
}

function isScoreBearing(type: PromptType) {
  return type === "visibility" || type === "ranking";
}

function isTerminalRun(status: string) {
  return (
    status === "completed" ||
    status === "partial_success" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
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
