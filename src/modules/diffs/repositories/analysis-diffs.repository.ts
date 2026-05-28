import type { AnalysisDiffInput, AnalysisDiffRow } from "../../../types/database.types.js";
import { BaseRepository } from "../../../repositories/base.repository.js";
import { SQL_QUERIES } from "../../../db/sql-queries.js";

export class AnalysisDiffsRepository extends BaseRepository<AnalysisDiffRow> {
  async insertAnalysisDiff(input: AnalysisDiffInput) {
    return this.executeSingleQueryOrThrow<AnalysisDiffRow>(
      SQL_QUERIES.analysisDiffs.insert,
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
      SQL_QUERIES.analysisDiffs.findByRunId,
      [analysisRunId]
    );
  }
}

export const analysisDiffsRepository = new AnalysisDiffsRepository();
