import type { AnalysisDiffInput, AnalysisDiffRow } from "../../../types/database.types.js";
import { BaseRepository } from "../../../repositories/base.repository.js";

export class AnalysisDiffsRepository extends BaseRepository<AnalysisDiffRow> {
  async insertAnalysisDiff(input: AnalysisDiffInput) {
    return this.executeSingleQueryOrThrow<AnalysisDiffRow>(
      `
        INSERT INTO analysis_diffs (
          domain_id,
          analysis_run_id,
          previous_analysis_run_id,
          diff_type,
          provider,
          old_value,
          new_value,
          severity
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `,
      [
        input.domainId,
        input.analysisRunId,
        input.previousAnalysisRunId,
        input.diffType,
        input.provider,
        JSON.stringify(input.oldValue),
        JSON.stringify(input.newValue),
        input.severity
      ],
      "Failed to insert analysis diff"
    );
  }

  async findDiffsByRunId(analysisRunId: number) {
    return this.executeQuery<AnalysisDiffRow>(
      `
        SELECT *
        FROM analysis_diffs
        WHERE analysis_run_id = $1
        ORDER BY created_at DESC
      `,
      [analysisRunId]
    );
  }
}

export const analysisDiffsRepository = new AnalysisDiffsRepository();
