import { PROVIDERS } from "../config/constants.js";
import { ProviderAnalysisRepository } from "../repositories/provider-analysis.repository.js";
import { VisibilityScoresRepository } from "../repositories/visibility-scores.repository.js";
import { BaseService } from "./base.service.js";
import type { ProviderAnalysisScoreRow } from "../types/database.types.js";
import type { ProviderName, TopKValue } from "../config/constants.js";

type VisibilityScoreServiceDependencies = {
  providerAnalysisRepository: ProviderAnalysisRepository;
  visibilityScoresRepository: VisibilityScoresRepository;
};

const TOP_K_WEIGHTS = {
  5: 0.5,
  10: 0.3,
  50: 0.2
} satisfies Partial<Record<TopKValue, number>>;

export class VisibilityScoreService extends BaseService {
  constructor(private readonly dependencies: VisibilityScoreServiceDependencies) {
    super();
  }

  async calculateAndStoreVisibilityScore(domainId: number) {
    this.log(`Calculating visibility score for domain: ${domainId}`);

    const scoringRows = await this.dependencies.providerAnalysisRepository.findLatestScoringRowsForDomain(domainId);
    const weightedRows = scoringRows.filter((row) => row.top_k in TOP_K_WEIGHTS);
    const completed = weightedRows.filter((row) => row.status === "completed");

    if (completed.length === 0) {
      this.logError(`No completed provider analysis rows found for domain: ${domainId}`);
    }

    // Provider scores use a weighted top-k model. Stronger top-k presence matters more than broad long-tail presence.
    // Only top 5, top 10, and top 50 contribute to the current provider aggregate.
    const providerScores = Object.fromEntries(
      PROVIDERS.map((provider) => {
        const providerRows = completed.filter((row) => row.llm_name === provider);
        const score = this.calculateWeightedProviderScore(providerRows);
        return [provider, score];
      })
    ) as Record<ProviderName, number>;

    const coverageScore = this.calculateCoverageScore(completed);
    const consistencyScore = this.calculateConsistencyScore(completed);
    const mentionFrequencyScore = this.calculateMentionFrequencyScore(completed);
    const providerAverage = this.average(Object.values(providerScores));
    const overallGeoScore = this.roundNumber(
      providerAverage * 0.6 +
        coverageScore * 0.2 +
        consistencyScore * 0.1 +
        mentionFrequencyScore * 0.1,
      2
    );

    this.log("Visibility scores calculated", {
      providerScores,
      providerAverage,
      coverageScore,
      consistencyScore,
      mentionFrequencyScore,
      overallGeoScore
    });

    return this.dependencies.visibilityScoresRepository.insertVisibilityScore({
      domain_id: domainId,
      openai_score: providerScores.openai,
      gemini_score: providerScores.gemini,
      claude_score: providerScores.claude,
      coverage_score: coverageScore,
      consistency_score: consistencyScore,
      mention_frequency_score: Math.min(100, mentionFrequencyScore),
      overall_geo_score: overallGeoScore
    });
  }

  private calculateWeightedProviderScore(providerRows: ProviderAnalysisScoreRow[]) {
    let weightedScore = 0;

    for (const row of providerRows) {
      weightedScore += Number(row.score) * (TOP_K_WEIGHTS[row.top_k as keyof typeof TOP_K_WEIGHTS] ?? 0);
    }

    return this.roundNumber(weightedScore, 2);
  }

  private calculateCoverageScore(completedRows: ProviderAnalysisScoreRow[]) {
    // Coverage answers: how many providers found the brand in the weighted top-k evaluations?
    const providersFound = new Set(
      completedRows
        .filter((row) => Number(row.score) > 0 || row.rank_position !== null || row.mention_count > 0)
        .map((row) => row.llm_name)
    );

    return this.roundNumber((providersFound.size / PROVIDERS.length) * 100, 2);
  }

  private calculateConsistencyScore(completedRows: ProviderAnalysisScoreRow[]) {
    // Consistency rewards providers ranking the brand at similar positions and penalizes missing providers.
    const bestRanksByProvider = PROVIDERS.map((provider) => {
      const ranks = completedRows
        .filter((row) => row.llm_name === provider && row.rank_position !== null)
        .map((row) => row.rank_position as number);

      return ranks.length > 0 ? Math.min(...ranks) : null;
    });

    const presentRanks = bestRanksByProvider.filter((rank): rank is number => rank !== null);
    if (presentRanks.length === 0) {
      return 0;
    }

    const rankSpread = Math.max(...presentRanks) - Math.min(...presentRanks);
    // A rank spread of 10 costs 20 points; a missing provider costs 25 points.
    const spreadPenalty = Math.min(100, rankSpread * 2);
    const missingProviderPenalty = (PROVIDERS.length - presentRanks.length) * 25;

    return this.roundNumber(Math.max(0, 100 - spreadPenalty - missingProviderPenalty), 2);
  }

  private calculateMentionFrequencyScore(completedRows: ProviderAnalysisScoreRow[]) {
    // Mentions are capped so repeated mentions can help but cannot dominate the final GEO score.
    const totalMentions = completedRows.reduce((sum, row) => sum + row.mention_count, 0);

    return this.roundNumber(Math.min(100, totalMentions * 10), 2);
  }
}
