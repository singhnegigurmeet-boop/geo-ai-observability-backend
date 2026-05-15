import { ProviderName } from "../../../config/constants.js";
import type {
  ProviderAnalysisInput,
  ProviderAnalysisScoreRow,
  ProviderAnalysisStatusRow,
  ProviderLatestScoreRow
} from "../../../types/database.types.js";
import { BaseRepository } from "../../../repositories/base.repository.js";

export class ProviderAnalysisRepository extends BaseRepository {
  async upsertProviderAnalysis(input: ProviderAnalysisInput) {
    return this.executeSingleQueryOrThrow<{ id: number }>(
      `
        INSERT INTO provider_analysis (
          domain_id,
          llm_name,
          top_k,
          rank_position,
          mention_count,
          score,
          status,
          error_message,
          last_run
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
        ON CONFLICT (domain_id, llm_name, top_k)
        DO UPDATE SET
          rank_position = EXCLUDED.rank_position,
          mention_count = EXCLUDED.mention_count,
          score = EXCLUDED.score,
          status = EXCLUDED.status,
          error_message = EXCLUDED.error_message,
          last_run = now(),
          updated_at = now()
        RETURNING id
      `,
      [
        input.domainId,
        input.llmName,
        input.topK,
        input.rankPosition,
        input.mentionCount,
        input.score,
        input.status,
        input.errorMessage
      ],
      "Failed to upsert provider analysis"
    );
  }

  async findProviderStatusesForDomain(domainId: number) {
    return this.executeQuery<ProviderAnalysisStatusRow>(
      `
        SELECT
          llm_name,
          CASE
            WHEN bool_or(status = 'completed') THEN 'completed'
            ELSE 'failed'
          END AS status,
          max(error_message) FILTER (WHERE error_message IS NOT NULL) AS error_message
        FROM provider_analysis
        WHERE domain_id = $1
        GROUP BY llm_name
        ORDER BY llm_name
      `,
      [domainId]
    );
  }

  async findLatestScoringRowsForDomain(domainId: number) {
    return this.executeQuery<ProviderAnalysisScoreRow>(
      `
        SELECT
          llm_name,
          top_k,
          rank_position,
          mention_count,
          score,
          status
        FROM provider_analysis
        WHERE domain_id = $1
        ORDER BY llm_name ASC, top_k ASC
      `,
      [domainId]
    );
  }

  async findLatestScoresByDomainAndProvider(domainId: number, llmName: ProviderName) {
    return this.executeQuery<ProviderLatestScoreRow>(
      `
        SELECT
          id,
          domain_id,
          llm_name,
          top_k,
          rank_position,
          mention_count,
          score,
          status,
          error_message,
          last_run,
          updated_at
        FROM provider_analysis
        WHERE domain_id = $1
          AND llm_name = $2
        ORDER BY top_k ASC
      `,
      [domainId, llmName]
    );
  }

  async findLatestScoresByDomain(domainId: number) {
    return this.executeQuery<ProviderLatestScoreRow>(
      `
        SELECT
          id,
          domain_id,
          llm_name,
          top_k,
          rank_position,
          mention_count,
          score,
          status,
          error_message,
          last_run,
          updated_at
        FROM provider_analysis
        WHERE domain_id = $1
        ORDER BY llm_name ASC, top_k ASC
      `,
      [domainId]
    );
  }
}

export const providerAnalysisRepository = new ProviderAnalysisRepository();
