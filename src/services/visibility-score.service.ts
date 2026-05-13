import { PROVIDERS } from "../config/constants.js";
import { ProviderSnapshotsRepository } from "../repositories/provider-snapshots.repository.js";
import { VisibilityScoresRepository } from "../repositories/visibility-scores.repository.js";
import { BaseService } from "./base.service.js";

type VisibilityScoreServiceDependencies = {
  providerSnapshotsRepository: ProviderSnapshotsRepository;
  visibilityScoresRepository: VisibilityScoresRepository;
};

export class VisibilityScoreService extends BaseService {
  constructor(private readonly dependencies: VisibilityScoreServiceDependencies) {
    super();
  }

  async calculateAndStoreVisibilityScore(domainId: number) {
    this.log(`Calculating visibility score for domain: ${domainId}`);

    const snapshots = await this.dependencies.providerSnapshotsRepository.findLatestProviderSnapshots(domainId);
    const completed = snapshots.filter((snapshot) => snapshot.status === "completed");

    if (completed.length === 0) {
      this.logError(`No completed snapshots found for domain: ${domainId}`);
    }

    const providerScores = Object.fromEntries(
      PROVIDERS.map((provider) => {
        const providerRows = completed.filter((snapshot) => snapshot.llm_name === provider);
        const score = this.roundNumber(this.average(providerRows.map((snapshot) => Number(snapshot.score))), 2);
        return [provider, score];
      })
    ) as Record<(typeof PROVIDERS)[number], number>;

    const providersWithSuccess = PROVIDERS.filter((provider) => providerScores[provider] > 0).length;
    const coverageScore = this.roundNumber((providersWithSuccess / PROVIDERS.length) * 100, 2);
    const mentionFrequencyScore = this.roundNumber(
      this.average(completed.map((snapshot) => Number(snapshot.mention_count))) * 20,
      2
    );
    const consistencyScore = this.roundNumber(
      100 - Math.min(100, this.calculateScoreSpread(Object.values(providerScores))),
      2
    );
    const overallGeoScore = this.roundNumber(
      this.average(Object.values(providerScores)) * 0.6 +
        coverageScore * 0.2 +
        consistencyScore * 0.1 +
        Math.min(100, mentionFrequencyScore) * 0.1,
      2
    );

    this.log("Visibility scores calculated", { providerScores, overallGeoScore });

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

  private calculateScoreSpread(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    return Math.max(...values) - Math.min(...values);
  }
}
