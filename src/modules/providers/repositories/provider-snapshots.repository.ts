import { BaseRepository } from "../../../repositories/base.repository.js";
import type { ProviderName } from "../../../config/constants.js";
import type {
  LatestProviderSnapshotRow,
  ProviderAnalysisInput,
  ProviderSnapshotRow
} from "../../../types/database.types.js";

export class ProviderSnapshotsRepository extends BaseRepository<ProviderSnapshotRow> {
  async insertProviderSnapshot(input: ProviderAnalysisInput) {
    return this.executeSingleQueryOrThrow<{ id: number }>(
      `
        INSERT INTO provider_snapshots (
          analysis_run_id,
          domain_id,
          llm_name,
          top_k,
          rank_position,
          mention_count,
          score,
          status,
          error_message
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `,
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
      `
        SELECT *
        FROM provider_snapshots
        WHERE analysis_run_id = $1
        ORDER BY llm_name ASC, top_k ASC
      `,
      [analysisRunId]
    );
  }

  async findLatestProviderSnapshots(domainId: number) {
    return this.executeQuery<LatestProviderSnapshotRow>(
      `
        SELECT DISTINCT ON (llm_name, top_k)
          llm_name,
          top_k,
          mention_count,
          score,
          status
        FROM provider_snapshots
        WHERE domain_id = $1
        ORDER BY llm_name, top_k, created_at DESC
      `,
      [domainId]
    );
  }

  async findProviderSnapshotHistory(domainId: number, llmName: ProviderName, limit = 50) {
    return this.executeQuery<ProviderSnapshotRow>(
      `
        SELECT *
        FROM provider_snapshots
        WHERE domain_id = $1
          AND llm_name = $2
        ORDER BY created_at DESC
        LIMIT $3
      `,
      [domainId, llmName, limit]
    );
  }
}

export const providerSnapshotsRepository = new ProviderSnapshotsRepository();
