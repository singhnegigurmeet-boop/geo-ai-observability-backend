import { TOP_K_VALUES } from "../../../config/constants.js";
import { env } from "../../../config/env.js";
import {
  buildObservabilityPrompt,
  buildRankingPrompt,
  buildScoringPrompt
} from "../../../prompts/geo.prompts.js";
import { ProviderAdapter, RankingResult, ScoringResult } from "../../../types/provider.types.js";
import { BaseService } from "../../../services/base.service.js";

type RankingJson = {
  category: string;
  rank: number | null;
  reason: string;
};

type ScoringJson = {
  top_k: number;
  brand_found: boolean;
  rank_position: number | null;
  mention_count: number;
  score: number;
  category: string;
  reason: string;
};

export class ProviderExecutionService extends BaseService {
  async executeProvider(adapter: ProviderAdapter, domain: string) {
    const rankingPrompt = buildRankingPrompt(domain);
    const observabilityPrompt = buildObservabilityPrompt(domain);

    const rankingResponse = await this.withRetries(
      () => adapter.runTextPrompt(rankingPrompt),
      env.PROVIDER_MAX_RETRIES
    );
    const rankingJson = this.parseJson<RankingJson>(rankingResponse, "Provider returned invalid ranking JSON");
    const ranking: RankingResult = {
      category: rankingJson.category,
      rank: rankingJson.rank,
      reason: rankingJson.reason,
      rawResponse: rankingResponse
    };

    const observabilityResponse = await this.withRetries(
      () => adapter.runTextPrompt(observabilityPrompt),
      env.PROVIDER_MAX_RETRIES
    );

    const scoring: ScoringResult[] = [];
    for (const topK of TOP_K_VALUES) {
      const scoringPrompt = buildScoringPrompt(domain, topK);
      const scoringResponse = await this.withRetries(
        () => adapter.runTextPrompt(scoringPrompt),
        env.PROVIDER_MAX_RETRIES
      );
      const scoringJson = this.parseJson<ScoringJson>(scoringResponse, "Provider returned invalid scoring JSON");

      scoring.push({
        topK,
        brandFound: scoringJson.brand_found,
        rankPosition: scoringJson.rank_position,
        mentionCount: scoringJson.mention_count,
        score: scoringJson.score,
        category: scoringJson.category,
        reason: scoringJson.reason,
        rawResponse: scoringResponse
      });
    }

    return {
      llmName: adapter.name,
      ranking,
      observabilityResponse,
      scoring
    };
  }
}
