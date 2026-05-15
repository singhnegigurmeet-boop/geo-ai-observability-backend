import type { AnalysisRunRow, AnalysisRunSource, AnalysisRunStatus } from "../../../types/database.types.js";
import { BaseRepository } from "../../../repositories/base.repository.js";
import { SQL_QUERIES } from "../../../db/sql-queries.js";

export class AnalysisRunsRepository extends BaseRepository<AnalysisRunRow> {
  async createQueuedRun(domainId: number, source: AnalysisRunSource = "manual") {
    return this.executeSingleQueryOrThrow<AnalysisRunRow>(
      SQL_QUERIES.analysisRuns.createQueuedRun,
      [domainId, source],
      "Failed to create analysis run"
    );
  }

  async attachBullMqJob(runId: number, bullmqJobId: string) {
    return this.executeSingleQueryOrThrow<AnalysisRunRow>(
      SQL_QUERIES.analysisRuns.attachBullMqJob,
      [runId, bullmqJobId],
      "Failed to attach BullMQ job to analysis run"
    );
  }

  async markProcessing(runId: number) {
    return this.executeSingleQueryOrThrow<AnalysisRunRow>(
      SQL_QUERIES.analysisRuns.markProcessing,
      [runId],
      "Failed to mark analysis run processing"
    );
  }

  async markFinished(runId: number, status: Extract<AnalysisRunStatus, "completed" | "partial_success" | "failed">, errorMessage: string | null) {
    return this.executeSingleQueryOrThrow<AnalysisRunRow>(
      SQL_QUERIES.analysisRuns.markFinished,
      [runId, status, errorMessage],
      "Failed to finish analysis run"
    );
  }

  async findById(runId: number) {
    return this.executeSingleQuery<AnalysisRunRow>(
      SQL_QUERIES.analysisRuns.findById,
      [runId]
    );
  }

  async findPreviousSuccessfulRun(domainId: number, currentRunId: number) {
    return this.executeSingleQuery<AnalysisRunRow>(
      SQL_QUERIES.analysisRuns.findPreviousSuccessfulRun,
      [domainId, currentRunId]
    );
  }
}

export const analysisRunsRepository = new AnalysisRunsRepository();
