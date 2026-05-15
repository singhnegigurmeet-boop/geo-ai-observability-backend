import { BaseRepository } from "../../../repositories/base.repository.js";
import { SQL_QUERIES } from "../../../db/sql-queries.js";
import type { ProviderName } from "../../../config/constants.js";
import type {
  LatestProviderSnapshotRow,
  ProviderAnalysisInput,
  ProviderSnapshotRow
} from "../../../types/database.types.js";

export class ProviderSnapshotsRepository extends BaseRepository<ProviderSnapshotRow> {
  async insertProviderSnapshot(input: ProviderAnalysisInput) {
    return this.executeSingleQueryOrThrow<{ id: number }>(
      SQL_QUERIES.providerSnapshots.insert,
      [
        input.analysisRunId ?? null,
        input.domainId,
        input.llmName,
        input.topK,
        input.rankPosition,
        input.mentionCount,
        input.score,
        input.status,
        input.errorMessage
      ],
      "Failed to insert provider snapshot"
    );
  }

  async findProviderSnapshotsByRunId(analysisRunId: number) {
    return this.executeQuery<ProviderSnapshotRow>(
      SQL_QUERIES.providerSnapshots.findByRunId,
      [analysisRunId]
    );
  }

  async findLatestProviderSnapshots(domainId: number) {
    return this.executeQuery<LatestProviderSnapshotRow>(
      SQL_QUERIES.providerSnapshots.findLatestByDomain,
      [domainId]
    );
  }

  async findProviderSnapshotHistory(domainId: number, llmName: ProviderName, limit = 50) {
    return this.executeQuery<ProviderSnapshotRow>(
      SQL_QUERIES.providerSnapshots.findHistoryByDomainAndProvider,
      [domainId, llmName, limit]
    );
  }
}

export const providerSnapshotsRepository = new ProviderSnapshotsRepository();
