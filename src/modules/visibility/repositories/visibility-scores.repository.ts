import { SQL_QUERIES } from "../../../db/sql-queries.js";
import type { VisibilityScoreRow } from "../../../types/database.types.js";
import { BaseRepository } from "../../../repositories/base.repository.js";

export class VisibilityScoresRepository extends BaseRepository<VisibilityScoreRow> {
  async findLatestVisibilityScore(domainId: number) {
    return this.executeSingleQuery<VisibilityScoreRow>(
      SQL_QUERIES.visibilityScores.findLatest,
      [domainId]
    );
  }

  async findVisibilityScoreHistory(domainId: number, limit = 50) {
    return this.executeQuery<VisibilityScoreRow>(
      SQL_QUERIES.visibilityScores.findHistory,
      [domainId, limit]
    );
  }

  async insertVisibilityScore(input: Omit<VisibilityScoreRow, "id" | "created_at">) {
    return this.executeSingleQueryOrThrow<VisibilityScoreRow>(
      SQL_QUERIES.visibilityScores.insert,
      [
        input.analysis_run_id,
        input.domain_id,
        input.openai_score,
        input.gemini_score,
        input.claude_score,
        input.coverage_score,
        input.consistency_score,
        input.mention_frequency_score,
        input.overall_geo_score
      ],
      "Failed to insert visibility score"
    );
  }

  async findVisibilityScoreByRunId(analysisRunId: number) {
    return this.executeSingleQuery<VisibilityScoreRow>(
      SQL_QUERIES.visibilityScores.findByRunId,
      [analysisRunId]
    );
  }
}

export const visibilityScoresRepository = new VisibilityScoresRepository();
