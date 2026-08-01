import type {
  AnalysisExecutionStatus,
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
  type DiscoveryReportRecord,
  type ReportMethodologyContext,
  type ReportExecutionRecord
} from "../repositories/report.repository.js";
import { buildExpectedProviderExecutionPlan } from "./expected-execution-plan.service.js";
import {
  reconcileExpectedProviderExecutions,
  reportExecutionRecords,
  type ReconciledProviderExecution
} from "./execution-reconciliation.service.js";
import {
  calculateExactCoverage,
  categoryCoverage,
  determineReportLifecycle,
  isTerminalRun,
  missingExpectedExecutionDetails,
  providerModelCoverage,
  reportIsFinal,
  type ReportLifecycleState
} from "./report-coverage.service.js";
import { consolidateDiagnostics } from "./report-consolidation.service.js";

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

type ModelPathScore = {
  entityPathId: string;
  categoryId: string | null;
  categoryName: string | null;
  provider: string;
  model: string;
  visibilityScore: number | null;
  rankingScore: number | null;
  geoScore: number | null;
  partial: boolean;
  availableMetricWeight: number;
  expectedMetricWeight: number;
  metricCoverage: number;
  missingMetricReasons: string[];
};

export class ReportAggregationService {
  constructor(private readonly reports: ReportRepository) {}

  async createIfReady(analysisRunId: string): Promise<ReportAggregationResult> {
    const run = await this.reports.lockRun(analysisRunId);
    if (!run) throw new Error(`Analysis run ${analysisRunId} does not exist`);
    const items = await this.reports.expectedPlanItems(analysisRunId);
    const providerModels =
      await this.reports.expectedPlanProviderModels(analysisRunId);
    const materialized = await this.reports.materializationRecords(
      analysisRunId,
      SCORING_VERSION
    );
    const expected = buildExpectedProviderExecutionPlan({
      run,
      items,
      providerModels
    });
    const reconciled = reconcileExpectedProviderExecutions({
      expected,
      materialized,
      runStatus: run.status
    });
    const discovery = await this.reports.discoveryRecord(
      analysisRunId
    );
    let methodology = await this.reports.methodologyContext(analysisRunId);
    const businessEmptyReason = resolveBusinessEmptyReason(
      discovery,
      items.length,
      expected.length,
      run.status
    );
    const coverage = calculateExactCoverage(reconciled);
    if (
      coverage.validScored + coverage.validDiagnostic === 0 &&
      coverage.pending > 0
    ) {
      return { outcome: "not_ready", reportId: null };
    }
    if (
      expected.length === 0 &&
      businessEmptyReason === null &&
      !isTerminalRun(run.status)
    ) {
      return { outcome: "not_ready", reportId: null };
    }
    const lifecycleState = determineReportLifecycle({
      runStatus: run.status,
      coverage,
      businessEmptyReason
    });
    let effectiveRunStatus = run.status;
    if (
      !isTerminalRun(run.status) &&
      coverage.pending === 0 &&
      coverage.budgetPaused === 0 &&
      lifecycleState !== "partial" &&
      lifecycleState !== "budget_paused_partial"
    ) {
      effectiveRunStatus = finalRunStatus(lifecycleState, coverage);
      await this.reports.markRunFinal(analysisRunId, effectiveRunStatus);
      methodology = await this.reports.methodologyContext(analysisRunId);
    }
    const data = buildMultiProviderReport(
      analysisRunId,
      reconciled,
      effectiveRunStatus,
      discovery,
      methodology,
      businessEmptyReason
    );
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
  reconciled: ReconciledProviderExecution[],
  runStatus: AnalysisExecutionStatus,
  discovery: DiscoveryReportRecord | null = null,
  methodology: ReportMethodologyContext | null = null,
  businessEmptyReason:
    | "no_matching_category"
    | "no_applicable_analysis_item"
    | null = null
) {
  const records = reportExecutionRecords(reconciled);
  const counts = calculateExactCoverage(reconciled);
  const lifecycleState = determineReportLifecycle({
    runStatus,
    coverage: counts,
    businessEmptyReason
  });

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
    providerResultId: record.provider_result_id,
    providerScoreId: record.provider_score_id,
    provider: record.provider,
    model: record.model,
    modelProfileVersion: record.model_profile_version ?? null,
    providerInstructionProfile:
      record.provider_instruction_profile ?? null,
    structuredOutputMode: record.structured_output_mode ?? null,
    state: record.provider_job_status,
    executionState:
      reconciled.find(
        (execution) =>
          execution.providerJobId === record.provider_job_id
      )?.executionState ?? "pending",
    evidenceStatus: record.result_status ?? "missing",
    score: record.score === null ? null : Number(record.score),
    scoringVersion: record.scoring_version,
    evidenceCount:
      record.validated_response &&
      Array.isArray(record.validated_response.evidence)
        ? record.validated_response.evidence.length
        : 0,
    confidence: responseConfidence(record.validated_response),
    terminalGapReason:
      safeGapReason(
        reconciled.find(
          (execution) =>
            execution.providerJobId === record.provider_job_id
        )?.executionState ?? "pending"
      ),
    usage: {
      inputTokens: Number(record.input_tokens ?? 0),
      outputTokens: Number(record.output_tokens ?? 0),
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
      expectedProviders: reconciled.filter(
        (execution) =>
          execution.expected.analysisRunItemId ===
            group[0]!.analysis_run_item_id &&
          execution.expected.promptType === group[0]!.prompt_type
      ).length
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
  const modelPaths = buildModelPathScores(reconciled);
  const categoryScores = buildCategoryScores(
    modelPaths,
    reconciled,
    methodology,
    discovery
  );
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
  const diagnosticSections = consolidateDiagnostics(records);
  const providerModelComparison = buildProviderModelComparison(
    reconciled,
    modelPaths
  );
  const promptOutcomes = buildPromptOutcomes(reconciled);
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
    emptyReason:
      lifecycleState === "completed_empty" ? businessEmptyReason : null,
    final: reportIsFinal({ runStatus, lifecycleState, coverage: counts }),
    resumePossible: false,
    summary: explanation(lifecycleState, counts),
    methodology: {
      analysisRunId,
      domain: methodology?.domain ?? null,
      requestedCategoryMode:
        methodology?.category_selection_mode ?? null,
      requestedCategoryIds: methodology?.requested_category_ids ?? [],
      matchedCategories: methodology?.matched_categories ?? [],
      hierarchyDiscoveryStatus: discovery?.discovery_status ?? null,
      hierarchyDiscoveryCoverage: discovery?.discovery_coverage ?? {},
      reused: discovery?.reused_from_pre_analysis_request_id !== null &&
        discovery?.reused_from_pre_analysis_request_id !== undefined,
      promptDepth: methodology?.prompt_depth ?? null,
      promptPolicyVersion: methodology?.prompt_policy_version ?? null,
      selectedProviderModels:
        methodology?.selected_provider_models ?? [],
      exactModelExecutionProfiles:
        methodology?.request_payload?.providerModels ??
        methodology?.selected_provider_models ??
        [],
      canonicalPlannerVersion:
        methodology?.request_payload?.canonicalPlannerVersion ?? null,
      canonicalRequestHash:
        methodology?.request_payload?.canonicalRequestHash ?? null,
      planningEstimate:
        methodology?.request_payload?.planningEstimate ?? null,
      businessPromptVersions: [
        ...new Set(records.map((record) => record.business_prompt_version))
      ].sort(),
      responseContractVersions: [
        ...new Set(records.map((record) => record.response_contract_version))
      ].sort(),
      normalPromptProfiles: uniquePromptProfiles(records),
      scoringVersion: SCORING_VERSION,
      reportVersion: MULTI_PROVIDER_REPORT_VERSION,
      reportRevisionStrategy: "immutable-authoritative-state-v1",
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
        (entry) => {
          const gaps = entry.visibilityGaps;
          return gaps &&
            typeof gaps === "object" &&
            !Array.isArray(gaps) &&
            Array.isArray(gaps.items)
            ? gaps.items
            : [];
        }
      ),
      strongestRecurringStrengths:
        diagnosticSections.visibility.flatMap((entry) => {
          const strengths = entry.strengths;
          return strengths &&
            typeof strengths === "object" &&
            !Array.isArray(strengths) &&
            Array.isArray(strengths.items)
            ? strengths.items
            : [];
        }),
      majorRankingWeakness: diagnosticSections.ranking.some(
        (entry) => typeof entry.foundRate === "number" && entry.foundRate < 0.5
      ),
      majorCompetitivePressure:
        diagnosticSections.competitors.flatMap((entry) => {
          const pressure = entry.competitivePressure;
          return pressure &&
            typeof pressure === "object" &&
            !Array.isArray(pressure) &&
            typeof pressure.average === "number"
            ? [pressure.average]
            : [];
        }).sort((left, right) => right - left)[0] ?? null
    },
    overallDimensions: {
      overallGeoScore: overallScore,
      averageVisibilityScore:
        visibilityScores.length ? mean(visibilityScores) : null,
      averageRankingScore: rankingScores.length ? mean(rankingScores) : null,
      averageConfidence: confidences.length ? mean(confidences) : null,
      categoryCoverage:
        categoryScores.length === 0
          ? null
          : round(
              categoryScores.filter((category) => category.geoScore !== null)
                .length / categoryScores.length
            ),
      scoreBearingCoverage: counts.scoreBearingCoverage,
      usableEvidenceCoverage: counts.usableEvidenceCoverage,
      providerAgreement: providerAgreement(modelPaths)
    },
    counts,
    coverage: counts,
    missingExpectedExecutions:
      missingExpectedExecutionDetails(reconciled),
    categoryCoverage: categoryCoverage(reconciled),
    promptScores,
    modelPathScores: modelPaths,
    categoryScores,
    categoryBreakdown: categoryScores,
    promptOutcomes,
    hierarchyDiscovery: discovery
      ? {
          status: discovery.discovery_status,
          coverage: discovery.discovery_coverage,
          reused: discovery.reused_from_pre_analysis_request_id !== null,
          usage: {
            inputTokens: Number(discovery.input_tokens ?? 0),
            outputTokens: Number(discovery.output_tokens ?? 0),
            costMicros: Number(discovery.cost_micros ?? 0),
            estimatedInputTokens:
              discovery.estimated_input_tokens === null ||
              discovery.estimated_input_tokens === undefined
                ? null
                : Number(discovery.estimated_input_tokens),
            estimatedOutputTokens:
              discovery.estimated_output_tokens === null ||
              discovery.estimated_output_tokens === undefined
                ? null
                : Number(discovery.estimated_output_tokens),
            estimatedCostMicros:
              discovery.estimated_cost_micros === null ||
              discovery.estimated_cost_micros === undefined
                ? null
                : Number(discovery.estimated_cost_micros)
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
        inputTokens: Number(discovery?.input_tokens ?? 0),
        outputTokens: Number(discovery?.output_tokens ?? 0),
        costMicros: Number(discovery?.cost_micros ?? 0)
      }
    ),
    usageAndCost: buildUsageAndCost(records, discovery, methodology)
  } satisfies JsonObject;
}

function buildCategoryScores(
  modelPaths: ModelPathScore[],
  reconciled: readonly ReconciledProviderExecution[],
  methodology: ReportMethodologyContext | null,
  discovery: DiscoveryReportRecord | null
) {
  const groups = new Map<
    string,
    ModelPathScore[]
  >();
  for (const path of modelPaths) {
    const key = path.categoryId ?? `path:${path.entityPathId}`;
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  const exactCoverage = categoryCoverage(reconciled);
  const matched = new Map<string, JsonObject>();
  for (const category of methodology?.matched_categories ?? []) {
    matched.set(String(category.categoryId), category);
  }
  return [...groups.values()].map((group) => {
    const scores = group
      .map((path) => path.geoScore)
      .filter((score): score is number => score !== null);
    const disagreement = statistics(scores);
    const categoryId = group[0]!.categoryId;
    const provenance = categoryId === null ? null : matched.get(categoryId);
    const categoryExecutions = reconciled.filter(
      (execution) => execution.expected.categoryId === categoryId
    );
    const coverage = calculateExactCoverage(categoryExecutions);
    return {
      categoryId,
      categoryName: group[0]!.categoryName,
      geoScore: scores.length ? mean(scores) : null,
      availableModels: scores.length,
      expectedModels: group.length,
      modelCoverage:
        group.length === 0 ? 0 : round((scores.length / group.length) * 100),
      discoverySource: discoverySource(
        provenance ?? undefined,
        discovery?.reused_from_pre_analysis_request_id !== null &&
          discovery?.reused_from_pre_analysis_request_id !== undefined,
        methodology?.created_at ?? null
      ),
      discoveryProviderResultProvenance:
        provenance?.providerResultId ?? null,
      discoveryRank: provenance?.discoveryRank ?? null,
      discoveryConfidence: provenance?.discoveryConfidence ?? null,
      providerModelPathScores: [...group].sort(compareModelPath),
      modelDisagreement: disagreement,
      validDiagnosticResultCount: coverage.validDiagnostic,
      invalidResultCount: coverage.invalid,
      technicalFailureCount: coverage.technicalFailure,
      budgetPausedCount: coverage.budgetPaused,
      cancelledCount: coverage.cancelled,
      missingBeforeFanOutCount: coverage.missingBeforeFanOut,
      permanentScoringFailureCount: coverage.permanentScoringFailure,
      expectedProviderExecutions: coverage.expectedProviderJobs,
      materializedProviderExecutions: coverage.materializedProviderJobs,
      usableEvidenceCoverage: coverage.usableEvidenceCoverage,
      scoreBearingCoverage: coverage.scoreBearingCoverage,
      promptOutcomes: buildPromptOutcomes(categoryExecutions),
      ...(exactCoverage.find(
        (coverage) => coverage.categoryId === group[0]!.categoryId
      ) ?? {})
    };
  }).sort(
    (left, right) =>
      (left.categoryName ?? "").localeCompare(right.categoryName ?? "") ||
      (left.categoryId ?? "").localeCompare(right.categoryId ?? "")
  );
}

function buildModelPathScores(
  reconciled: readonly ReconciledProviderExecution[]
): ModelPathScore[] {
  const groups = new Map<string, ReconciledProviderExecution[]>();
  for (const execution of reconciled) {
    const key =
      `${execution.expected.entityPathId}\u0000` +
      `${execution.expected.provider}\u0000${execution.expected.model}`;
    const group = groups.get(key) ?? [];
    group.push(execution);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const records = reportExecutionRecords(group);
    const visibility = scoreFor(records, "visibility");
    const ranking = scoreFor(records, "ranking");
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
      entityPathId: group[0]!.expected.entityPathId,
      categoryId: group[0]!.expected.categoryId,
      categoryName: group[0]!.expected.categoryName,
      provider: group[0]!.expected.provider,
      model: group[0]!.expected.model,
      visibilityScore: visibility,
      rankingScore: ranking,
      geoScore,
      partial: availableWeight > 0 && availableWeight < 1,
      availableMetricWeight: availableWeight,
      expectedMetricWeight: 1,
      metricCoverage: round(availableWeight * 100),
      missingMetricReasons: [
        ...(visibility === null
          ? [missingReason(group, "visibility")]
          : []),
        ...(ranking === null ? [missingReason(group, "ranking")] : [])
      ]
    };
  }).sort(compareModelPath);
}

function scoreFor(records: ReportExecutionRecord[], type: PromptType) {
  const record = records.find((candidate) => candidate.prompt_type === type);
  return record?.score === null || record?.score === undefined
    ? null
    : Number(record.score);
}

function missingReason(
  executions: readonly ReconciledProviderExecution[],
  type: PromptType
) {
  const execution = executions.find(
    (candidate) => candidate.expected.promptType === type
  );
  if (!execution) return `${type}:not_expected`;
  if (execution.executionState === "permanent_scoring_failure") {
    return `${type}:scoring_failed:${
      execution.actual?.scoring_failure_code ?? "permanent"
    }`;
  }
  return `${type}:${execution.executionState}`;
}

function buildProviderModelComparison(
  reconciled: readonly ReconciledProviderExecution[],
  modelPaths: ModelPathScore[]
) {
  const groups = new Map<string, ReconciledProviderExecution[]>();
  for (const execution of reconciled) {
    const key =
      `${execution.expected.provider}\u0000${execution.expected.model}`;
    const group = groups.get(key) ?? [];
    group.push(execution);
    groups.set(key, group);
  }
  const exact = new Map(
    providerModelCoverage(reconciled).map((coverage) => [
      `${coverage.provider}\u0000${coverage.model}`,
      coverage
    ])
  );
  return [...groups.entries()].map(([key, group]) => {
    const records = reportExecutionRecords(group);
    const scores = modelPaths
      .filter(
        (path) =>
          path.provider === group[0]!.expected.provider &&
          path.model === group[0]!.expected.model &&
          path.geoScore !== null
      )
      .map((path) => path.geoScore as number);
    return {
      provider: group[0]!.expected.provider,
      model: group[0]!.expected.model,
      averageGeoScore: scores.length ? mean(scores) : null,
      modelPathScoreCount: scores.length,
      partialModelPathScoreCount: modelPaths.filter(
        (path) =>
          path.provider === group[0]!.expected.provider &&
          path.model === group[0]!.expected.model &&
          path.partial
      ).length,
      validScoreBearingResults: group.filter(
        (execution) => execution.executionState === "valid_scored"
      ).length,
      validDiagnosticResults: group.filter(
        (execution) => execution.executionState === "valid_diagnostic"
      ).length,
      invalidResults: group.filter(
        (execution) => execution.executionState === "invalid"
      ).length,
      technicalFailures: group.filter(
        (execution) => execution.executionState === "technical_failure"
      ).length,
      budgetPausedJobs: group.filter(
        (execution) => execution.executionState === "budget_paused"
      ).length,
      cancelledJobs: group.filter(
        (execution) => execution.executionState === "cancelled"
      ).length,
      pendingJobs: group.filter(
        (execution) =>
          execution.executionState === "pending" ||
          execution.executionState === "valid_score_pending"
      ).length,
      ...(exact.get(key) ?? {}),
      usage: records.reduce(
        (total, record) => ({
          inputTokens: total.inputTokens + Number(record.input_tokens ?? 0),
          outputTokens: total.outputTokens + Number(record.output_tokens ?? 0),
          costMicros: total.costMicros + Number(record.cost_micros ?? 0),
          estimatedCostMicros:
            total.estimatedCostMicros +
            Number(record.estimated_cost_micros ?? 0)
        }),
        {
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          estimatedCostMicros: 0
        }
      )
    };
  }).sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.model.localeCompare(right.model)
  );
}

function buildUsageAndCost(
  records: ReportExecutionRecord[],
  discovery: DiscoveryReportRecord | null,
  methodology: ReportMethodologyContext | null
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
    current.inputTokens += Number(record.input_tokens ?? 0);
    current.outputTokens += Number(record.output_tokens ?? 0);
    current.costMicros += Number(record.cost_micros ?? 0);
    byCategory.set(key, current);
  }
  const byProviderModel = usageGroups(
    records,
    (record) => `${record.provider}\u0000${record.model}`,
    (record) => ({ provider: record.provider, model: record.model })
  );
  const byPromptType = usageGroups(
    records,
    (record) => record.prompt_type,
    (record) => ({ promptType: record.prompt_type })
  );
  const normalActual = usageTotal(records);
  const discoveryActual = {
    inputTokens: Number(discovery?.input_tokens ?? 0),
    outputTokens: Number(discovery?.output_tokens ?? 0),
    totalTokens:
      Number(discovery?.input_tokens ?? 0) +
      Number(discovery?.output_tokens ?? 0),
    costMicros: Number(discovery?.cost_micros ?? 0)
  };
  const actual = addUsage(normalActual, discoveryActual);
  const planningEstimate =
    methodology?.request_payload?.planningEstimate ?? null;
  const estimatedCost =
    planningEstimate &&
    typeof planningEstimate === "object" &&
    !Array.isArray(planningEstimate)
      ? planningEstimate.costEstimateMicros ?? null
      : null;
  return {
    planningEstimate,
    estimatedCostRangeMicros: estimatedCost,
    actual,
    normalAnalysis: normalActual,
    hierarchyDiscovery: discoveryActual,
    byProviderModel,
    byCategory: [...byCategory.values()].sort((left, right) =>
      (left.categoryId ?? "").localeCompare(right.categoryId ?? "")
    ),
    byPromptType,
    missingTelemetryCount:
      records.filter(
        (record) =>
          record.input_tokens === null ||
          record.output_tokens === null ||
          record.cost_micros === null
      ).length +
      (discovery &&
      (discovery.input_tokens === null ||
        discovery.output_tokens === null ||
        discovery.cost_micros === null)
        ? 1
        : 0),
    costVarianceMicros:
      estimatedCost &&
      typeof estimatedCost === "object" &&
      !Array.isArray(estimatedCost) &&
      typeof estimatedCost.minimum === "number" &&
      typeof estimatedCost.maximum === "number"
        ? {
            versusMinimum: actual.costMicros - estimatedCost.minimum,
            versusMaximum: actual.costMicros - estimatedCost.maximum
          }
        : null
  };
}

function usageTotal(records: readonly ReportExecutionRecord[]) {
  return records.reduce(
    (total, record) => ({
      inputTokens: total.inputTokens + Number(record.input_tokens ?? 0),
      outputTokens: total.outputTokens + Number(record.output_tokens ?? 0),
      totalTokens:
        total.totalTokens +
        Number(record.input_tokens ?? 0) +
        Number(record.output_tokens ?? 0),
      costMicros: total.costMicros + Number(record.cost_micros ?? 0),
      estimatedCostMicros:
        total.estimatedCostMicros +
        Number(record.estimated_cost_micros ?? 0)
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costMicros: 0,
      estimatedCostMicros: 0
    }
  );
}

function usageGroups(
  records: readonly ReportExecutionRecord[],
  keyFor: (record: ReportExecutionRecord) => string,
  identityFor: (record: ReportExecutionRecord) => JsonObject
) {
  const groups = new Map<string, ReportExecutionRecord[]>();
  for (const record of records) {
    const key = keyFor(record);
    const values = groups.get(key) ?? [];
    values.push(record);
    groups.set(key, values);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, values]) => ({
      ...identityFor(values[0]!),
      ...usageTotal(values)
    }));
}

function addUsage(
  left: ReturnType<typeof usageTotal>,
  right: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costMicros: number;
  }
) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costMicros: left.costMicros + right.costMicros
  };
}

function providerAgreement(
  modelPaths: ModelPathScore[]
) {
  const scores = modelPaths
    .map((path) => path.geoScore)
    .filter((score): score is number => score !== null);
  if (scores.length < 2) return null;
  return round(
    Math.max(0, 100 - (Math.max(...scores) - Math.min(...scores)))
  );
}

function buildPromptOutcomes(
  reconciled: readonly ReconciledProviderExecution[]
) {
  return [...reconciled]
    .sort(
      (left, right) =>
        left.expected.itemOrdinal - right.expected.itemOrdinal ||
        left.expected.promptOrdinal - right.expected.promptOrdinal ||
        left.expected.provider.localeCompare(right.expected.provider) ||
        left.expected.model.localeCompare(right.expected.model)
    )
    .map((execution) => ({
      entityPathId: execution.expected.entityPathId,
      categoryId: execution.expected.categoryId,
      provider: execution.expected.provider,
      model: execution.expected.model,
      promptType: execution.expected.promptType,
      requiresScoring: execution.expected.requiresScoring,
      materializationStage: execution.materializationStage,
      executionState: execution.executionState,
      providerResultValidity:
        execution.actual?.result_status ?? "missing",
      scoreAvailable: execution.providerScoreId !== null,
      terminalGapReason: safeGapReason(execution.executionState),
      budgetPaused: execution.executionState === "budget_paused",
      cancelled: execution.executionState === "cancelled"
    }));
}

function uniquePromptProfiles(records: readonly ReportExecutionRecord[]) {
  const profiles = new Map<string, JsonObject>();
  for (const record of records) {
    const key = [
      record.prompt_type,
      record.business_prompt_version,
      record.response_contract_version,
      record.provider,
      record.model,
      record.model_profile_version ?? "",
      record.provider_instruction_profile ?? "",
      record.structured_output_mode ?? ""
    ].join("\u0000");
    profiles.set(key, {
      promptType: record.prompt_type,
      businessPromptVersion: record.business_prompt_version,
      responseContractVersion: record.response_contract_version,
      provider: record.provider,
      model: record.model,
      modelProfileVersion: record.model_profile_version ?? null,
      providerInstructionProfile:
        record.provider_instruction_profile ?? null,
      structuredOutputMode: record.structured_output_mode ?? null
    });
  }
  return [...profiles.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, profile]) => profile);
}

function safeGapReason(state: ReconciledProviderExecution["executionState"]) {
  if (state === "invalid") return "invalid_evidence";
  if (state === "technical_failure") return "technical_failure";
  if (state === "budget_paused") return "budget_paused";
  if (state === "cancelled") return "cancelled";
  if (state === "missing_before_fan_out") {
    return "expected_but_not_materialized";
  }
  if (state === "permanent_scoring_failure") {
    return "permanent_scoring_failure";
  }
  if (state === "pending" || state === "valid_score_pending") return "pending";
  return null;
}

function statistics(values: number[]) {
  if (values.length === 0) {
    return {
      minimum: null,
      maximum: null,
      range: null,
      standardDeviation: null
    };
  }
  const average = mean(values);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return {
    minimum,
    maximum,
    range: round(maximum - minimum),
    standardDeviation:
      values.length < 2
        ? null
        : round(
            Math.sqrt(
              mean(values.map((value) => (value - average) ** 2))
            )
          )
  };
}

function compareModelPath(
  left: ModelPathScore,
  right: ModelPathScore
) {
  return (
    (left.categoryName ?? "").localeCompare(right.categoryName ?? "") ||
    (left.categoryId ?? "").localeCompare(right.categoryId ?? "") ||
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model) ||
    left.entityPathId.localeCompare(right.entityPathId)
  );
}

function discoverySource(
  provenance: JsonObject | undefined,
  reused: boolean,
  runCreatedAt: string | null
) {
  if (!provenance) return null;
  if (provenance.source === "manual") return "reused_manual";
  if (provenance.source === "import") return "reused_import";
  if (provenance.source !== "llm_discovery") {
    return typeof provenance.source === "string"
      ? provenance.source
      : null;
  }
  if (reused) return "reused_discovery";
  const relationshipCreatedAt =
    typeof provenance.relationshipCreatedAt === "string"
      ? Date.parse(provenance.relationshipCreatedAt)
      : Number.NaN;
  const runCreated = runCreatedAt ? Date.parse(runCreatedAt) : Number.NaN;
  return Number.isFinite(relationshipCreatedAt) &&
    Number.isFinite(runCreated) &&
    relationshipCreatedAt < runCreated
    ? "concurrently_reused_or_reactivated"
    : "newly_discovered";
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

function resolveBusinessEmptyReason(
  _discovery: DiscoveryReportRecord | null,
  itemCount: number,
  expectedCount: number,
  runStatus: AnalysisExecutionStatus
): "no_matching_category" | "no_applicable_analysis_item" | null {
  if (expectedCount !== 0) return null;
  if (
    itemCount === 0 &&
    (runStatus === "completed" || runStatus === "partial_success")
  ) {
    return "no_applicable_analysis_item";
  }
  return null;
}

function finalRunStatus(
  lifecycleState: ReportLifecycleState,
  coverage: ReturnType<typeof calculateExactCoverage>
): "completed" | "partial_success" | "failed" | "cancelled" {
  if (lifecycleState === "completed") return "completed";
  if (lifecycleState === "completed_empty") return "completed";
  if (lifecycleState === "failed_empty") return "failed";
  if (lifecycleState.startsWith("cancelled")) return "cancelled";
  return coverage.validScored + coverage.validDiagnostic > 0
    ? "partial_success"
    : "failed";
}
