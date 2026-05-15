import type { AnalysisRunRow, AnalysisRunSource, AnalysisRunStatus } from "../../../types/database.types.js";
import { BaseRepository } from "../../../repositories/base.repository.js";

export class AnalysisRunsRepository extends BaseRepository<AnalysisRunRow> {
  async createQueuedRun(domainId: number, source: AnalysisRunSource = "manual") {
    return this.executeSingleQueryOrThrow<AnalysisRunRow>(
      `
        INSERT INTO analysis_runs (domain_id, status, source)
        VALUES ($1, 'queued', $2)
        RETURNING *
      `,
      [domainId, source],
      "Failed to create analysis run"
    );
  }

  async attachBullMqJob(runId: number, bullmqJobId: string) {
    return this.executeSingleQueryOrThrow<AnalysisRunRow>(
      `
        UPDATE analysis_runs
        SET bullmq_job_id = $2, updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [runId, bullmqJobId],
      "Failed to attach BullMQ job to analysis run"
    );
  }

  async markProcessing(runId: number) {
    return this.updateStatus(runId, "processing", {
      startedAtExpression: "coalesce(started_at, now())"
    });
  }

  async markFinished(runId: number, status: Extract<AnalysisRunStatus, "completed" | "partial_success" | "failed">, errorMessage: string | null) {
    return this.executeSingleQueryOrThrow<AnalysisRunRow>(
      `
        UPDATE analysis_runs
        SET
          status = $2,
          error_message = $3,
          completed_at = now(),
          updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [runId, status, errorMessage],
      "Failed to finish analysis run"
    );
  }

  async findById(runId: number) {
    return this.executeSingleQuery<AnalysisRunRow>(
      `
        SELECT *
        FROM analysis_runs
        WHERE id = $1
      `,
      [runId]
    );
  }

  async findPreviousSuccessfulRun(domainId: number, currentRunId: number) {
    return this.executeSingleQuery<AnalysisRunRow>(
      `
        SELECT *
        FROM analysis_runs
        WHERE domain_id = $1
          AND id <> $2
          AND status IN ('completed', 'partial_success')
        ORDER BY completed_at DESC NULLS LAST, id DESC
        LIMIT 1
      `,
      [domainId, currentRunId]
    );
  }

  private async updateStatus(
    runId: number,
    status: AnalysisRunStatus,
    options: { startedAtExpression?: string } = {}
  ) {
    const startedAtSql = options.startedAtExpression
      ? `started_at = ${options.startedAtExpression},`
      : "";

    return this.executeSingleQueryOrThrow<AnalysisRunRow>(
      `
        UPDATE analysis_runs
        SET
          status = $2,
          ${startedAtSql}
          updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [runId, status],
      "Failed to update analysis run"
    );
  }
}

export const analysisRunsRepository = new AnalysisRunsRepository();
