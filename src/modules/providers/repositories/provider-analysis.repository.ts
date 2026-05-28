import { ProviderName } from "../../../config/constants.js";
import { SQL_QUERIES } from "../../../db/sql-queries.js";
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
      SQL_QUERIES.providerAnalysis.upsert,
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
      SQL_QUERIES.providerAnalysis.findStatusesForDomain,
      [domainId]
    );
  }

  async findLatestScoringRowsForDomain(domainId: number) {
    return this.executeQuery<ProviderAnalysisScoreRow>(
      SQL_QUERIES.providerAnalysis.findLatestScoringRowsForDomain,
      [domainId]
    );
  }

  async findLatestScoresByDomainAndProvider(domainId: number, llmName: ProviderName) {
    return this.executeQuery<ProviderLatestScoreRow>(
      SQL_QUERIES.providerAnalysis.findLatestScoresByDomainAndProvider,
      [domainId, llmName]
    );
  }

  async findLatestScoresByDomain(domainId: number) {
    return this.executeQuery<ProviderLatestScoreRow>(
      SQL_QUERIES.providerAnalysis.findLatestScoresByDomain,
      [domainId]
    );
  }
}

export const providerAnalysisRepository = new ProviderAnalysisRepository();
