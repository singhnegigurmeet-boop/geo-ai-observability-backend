import { Redis } from "ioredis";
import { ProviderName, TOP_K_VALUES } from "../../../config/constants.js";
import { buildObservabilityPrompt, buildRankingPrompt, buildScoringPrompt } from "../../../prompts/geo.prompts.js";
import { AnalysisRunsRepository } from "../repositories/analysis-runs.repository.js";
import { ProviderAnalysisRepository } from "../../providers/repositories/provider-analysis.repository.js";
import { ProviderSnapshotsRepository } from "../../providers/repositories/provider-snapshots.repository.js";
import type { TraceDocument } from "../../../types/observability.types.js";
import type { ProviderAdapter } from "../../../types/provider.types.js";
import type { AnalysisJobData } from "../../../types/queue.types.js";
import { ObservabilityIndexService } from "../../observability/services/observability-index.service.js";
import { ProviderExecutionService } from "../../providers/services/provider-execution.service.js";
import { VisibilityScoreService } from "../../visibility/services/visibility-score.service.js";
import { DiffEngineService } from "../../diffs/services/diff-engine.service.js";

type AnalysisJobServiceDependencies = {
  analysisRunsRepository: AnalysisRunsRepository;
  providerAnalysisRepository: ProviderAnalysisRepository;
  providerSnapshotsRepository: ProviderSnapshotsRepository;
  providerExecutionService: ProviderExecutionService;
  visibilityScoreService: VisibilityScoreService;
  diffEngineService: DiffEngineService;
  observabilityIndexService: ObservabilityIndexService;
  providerAdapters: ProviderAdapter[];
  redis: Redis;
  cacheTtlSeconds: number;
  providerMaxRetries: number;
};

type SuccessfulProviderResult = Awaited<ReturnType<ProviderExecutionService["executeProvider"]>>;

export class AnalysisJobService {
  constructor(private readonly dependencies: AnalysisJobServiceDependencies) {}

  async processAnalysisJob(job: AnalysisJobData) {
    await this.dependencies.analysisRunsRepository.markProcessing(job.analysisRunId);

    const providerResults = await Promise.allSettled(
      this.dependencies.providerAdapters.map((adapter) =>
        this.dependencies.providerExecutionService.executeProvider(adapter, job.domain)
      )
    );

    const traceDocuments: TraceDocument[] = [];

    for (const [index, result] of providerResults.entries()) {
      const adapter = this.dependencies.providerAdapters[index];
      if (!adapter) {
        throw new Error(`Missing provider adapter at index ${index}`);
      }

      if (result.status === "fulfilled") {
        traceDocuments.push(...(await this.persistProviderSuccess(job, result.value)));
      } else {
        traceDocuments.push(...(await this.persistProviderFailure(job, adapter.name, result.reason)));
      }
    }

    const completedProviders = providerResults.filter((result) => result.status === "fulfilled").length;
    const failedProviders = providerResults.length - completedProviders;

    if (completedProviders === 0) {
      await this.dependencies.observabilityIndexService.indexProviderTraces(traceDocuments);
      await this.dependencies.analysisRunsRepository.markFinished(
        job.analysisRunId,
        "failed",
        "Analysis failed. All providers failed after retries."
      );

      return null;
    }

    const visibilityScore = await this.dependencies.visibilityScoreService.calculateAndStoreVisibilityScore(
      job.domainId,
      job.analysisRunId
    );
    await this.dependencies.observabilityIndexService.indexProviderTraces(
      traceDocuments.map((document) => ({
        ...document,
        overall_geo_score: Number(visibilityScore.overall_geo_score)
      }))
    );
    await this.dependencies.redis.set(
      `analysis:${job.domain}`,
      JSON.stringify(visibilityScore),
      "EX",
      this.dependencies.cacheTtlSeconds
    );
    await this.dependencies.analysisRunsRepository.markFinished(
      job.analysisRunId,
      failedProviders > 0 ? "partial_success" : "completed",
      failedProviders > 0 ? `${failedProviders} provider(s) failed after retries.` : null
    );
    await this.calculateDiffs(job);

    return visibilityScore;
  }

  private async persistProviderSuccess(job: AnalysisJobData, result: SuccessfulProviderResult) {
    const traceDocuments: TraceDocument[] = [];
    const rankingPromptText = buildRankingPrompt(job.domain);
    const observabilityPromptText = buildObservabilityPrompt(job.domain);

    for (const scoringResult of result.scoring) {
      const scoringPromptText = buildScoringPrompt(job.domain, scoringResult.topK);
      const providerAnalysis = await this.dependencies.providerAnalysisRepository.upsertProviderAnalysis({
        domainId: job.domainId,
        llmName: result.llmName,
        topK: scoringResult.topK,
        rankPosition: scoringResult.rankPosition,
        mentionCount: scoringResult.mentionCount,
        score: scoringResult.score,
        status: "completed",
        errorMessage: null
      });

      const providerSnapshot = await this.dependencies.providerSnapshotsRepository.insertProviderSnapshot({
        analysisRunId: job.analysisRunId,
        domainId: job.domainId,
        llmName: result.llmName,
        topK: scoringResult.topK,
        rankPosition: scoringResult.rankPosition,
        mentionCount: scoringResult.mentionCount,
        score: scoringResult.score,
        status: "completed",
        errorMessage: null
      });

      traceDocuments.push({
        provider_analysis_id: providerAnalysis.id,
        provider_snapshot_id: providerSnapshot.id,
        domain: job.domain,
        llm_name: result.llmName,
        ranking_prompt_name: "json_ranking_prompt",
        ranking_prompt_text: rankingPromptText,
        ranking_prompt_response: result.ranking.rawResponse,
        observability_prompt_name: "full_observability_prompt",
        observability_prompt_text: observabilityPromptText,
        observability_prompt_response: result.observabilityResponse,
        scoring_prompt_name: "geo_scoring_prompt",
        scoring_prompt_text: scoringPromptText,
        scoring_prompt_response: scoringResult.rawResponse,
        top_k: scoringResult.topK,
        rank_position: scoringResult.rankPosition,
        mention_count: scoringResult.mentionCount,
        provider_score: scoringResult.score,
        overall_geo_score: null,
        status: "completed",
        error_type: null,
        error_message: null,
        retry_count: this.dependencies.providerMaxRetries,
        timestamp: new Date().toISOString()
      });
    }

    return traceDocuments;
  }

  private async persistProviderFailure(job: AnalysisJobData, provider: ProviderName, error: unknown) {
    const traceDocuments: TraceDocument[] = [];
    const errorMessage = error instanceof Error ? error.message : "Unknown provider error";
    const rankingPromptText = buildRankingPrompt(job.domain);
    const observabilityPromptText = buildObservabilityPrompt(job.domain);

    for (const topK of TOP_K_VALUES) {
      const scoringPromptText = buildScoringPrompt(job.domain, topK);
      const providerAnalysis = await this.dependencies.providerAnalysisRepository.upsertProviderAnalysis({
        domainId: job.domainId,
        llmName: provider,
        topK,
        rankPosition: null,
        mentionCount: 0,
        score: 0,
        status: "failed",
        errorMessage
      });

      const providerSnapshot = await this.dependencies.providerSnapshotsRepository.insertProviderSnapshot({
        analysisRunId: job.analysisRunId,
        domainId: job.domainId,
        llmName: provider,
        topK,
        rankPosition: null,
        mentionCount: 0,
        score: 0,
        status: "failed",
        errorMessage
      });

      traceDocuments.push({
        provider_analysis_id: providerAnalysis.id,
        provider_snapshot_id: providerSnapshot.id,
        domain: job.domain,
        llm_name: provider,
        ranking_prompt_name: "json_ranking_prompt",
        ranking_prompt_text: rankingPromptText,
        ranking_prompt_response: null,
        observability_prompt_name: "full_observability_prompt",
        observability_prompt_text: observabilityPromptText,
        observability_prompt_response: null,
        scoring_prompt_name: "geo_scoring_prompt",
        scoring_prompt_text: scoringPromptText,
        scoring_prompt_response: null,
        top_k: topK,
        rank_position: null,
        mention_count: 0,
        provider_score: 0,
        overall_geo_score: null,
        status: "failed",
        error_type: "provider_execution_error",
        error_message: errorMessage,
        retry_count: this.dependencies.providerMaxRetries,
        timestamp: new Date().toISOString()
      });
    }

    return traceDocuments;
  }

  private async calculateDiffs(job: AnalysisJobData) {
    try {
      const diffs = await this.dependencies.diffEngineService.calculateAndStoreDiffs(
        job.domainId,
        job.analysisRunId
      );

      if (diffs.length > 0) {
        console.log(`Stored ${diffs.length} analysis diff(s) for run ${job.analysisRunId}`);
      }
    } catch (error) {
      console.error(`Failed to calculate analysis diffs for run ${job.analysisRunId}`, error);
    }
  }
}
