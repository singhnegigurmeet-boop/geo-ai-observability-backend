import { query } from "../lib/postgres.js";
import type { VisibilityScoreRow } from "../types/database.types.js";
import { BaseRepository } from "./base.repository.js";

export class VisibilityScoresRepository extends BaseRepository<VisibilityScoreRow> {
  async findLatestVisibilityScore(domainId: number) {
    return this.executeSingleQuery<VisibilityScoreRow>(
      `
        SELECT *
        FROM visibility_scores
        WHERE domain_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [domainId]
    );
  }

  async insertVisibilityScore(input: Omit<VisibilityScoreRow, "id" | "created_at">) {
    const result = await query<VisibilityScoreRow>(
      `
        INSERT INTO visibility_scores (
          domain_id,
          openai_score,
          gemini_score,
          claude_score,
          coverage_score,
          consistency_score,
          mention_frequency_score,
          overall_geo_score
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
      [
        input.domain_id,
        input.openai_score,
        input.gemini_score,
        input.claude_score,
        input.coverage_score,
        input.consistency_score,
        input.mention_frequency_score,
        input.overall_geo_score
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to insert visibility score");
    }

    return row;
  }
}

export const visibilityScoresRepository = new VisibilityScoresRepository();
