import { SQL_QUERIES } from "../../../db/sql-queries.js";
import { withTransaction } from "../../../lib/postgres.js";
import { BaseRepository } from "../../../repositories/base.repository.js";
import type {
  AnalysisRunFilters,
  AnalysisRunItemRow,
  AnalysisRunInput,
  AnalysisRunRow,
  AnalysisRunSource,
  AnalysisRunStatus
} from "../../../types/database.types.js";

export type AnalysisRunWithItemsInput = {
  domainId: number;
  requestPayload: unknown;
  pathIds: number[];
  status?: AnalysisRunStatus;
};

export type AnalysisRunWithDomainRow = AnalysisRunRow & {
  domain: string;
};

export class AnalysisRunsRepository extends BaseRepository<AnalysisRunRow> {
  async createAnalysisRun(input: AnalysisRunInput): Promise<AnalysisRunRow> {
    return this.executeSingleQueryOrThrow<AnalysisRunRow>(
      SQL_QUERIES.analysisRuns.createAnalysisRun,
      [input.domainId, JSON.stringify(input.requestPayload), input.status ?? null],
      "Failed to create analysis run"
    );
  }

  async createAnalysisRunWithItems(input: AnalysisRunWithItemsInput): Promise<{
    analysisRun: AnalysisRunRow;
    runItems: AnalysisRunItemRow[];
  }> {
    return withTransaction(async (client) => {
      const runResult = await client.query<AnalysisRunRow>(SQL_QUERIES.analysisRuns.createAnalysisRun, [
        input.domainId,
        JSON.stringify(input.requestPayload),
        input.status ?? "queued"
      ]);
      const analysisRun = runResult.rows[0];

      if (!analysisRun) {
        throw new Error("Failed to create analysis run");
      }

      if (input.pathIds.length === 0) {
        return { analysisRun, runItems: [] };
      }

      const itemsResult = await client.query<AnalysisRunItemRow>(SQL_QUERIES.analysisRunItems.createMany, [
        analysisRun.analysis_run_id,
        input.pathIds
      ]);

      return { analysisRun, runItems: itemsResult.rows };
    });
  }

  async getAnalysisRunById(analysisRunId: number): Promise<AnalysisRunRow | null> {
    return this.executeSingleQuery<AnalysisRunRow>(SQL_QUERIES.analysisRuns.findById, [analysisRunId]);
  }

  async getAnalysisRunWithItems(analysisRunId: number): Promise<AnalysisRunWithDomainRow | null> {
    return this.executeSingleQuery<AnalysisRunWithDomainRow>(SQL_QUERIES.analysisRuns.findByIdWithDomain, [
      analysisRunId
    ]);
  }

  async updateAnalysisRunStatus(
    analysisRunId: number,
    status: AnalysisRunStatus
  ): Promise<AnalysisRunRow | null> {
    return this.executeSingleQuery<AnalysisRunRow>(SQL_QUERIES.analysisRuns.updateStatus, [
      analysisRunId,
      status
    ]);
  }

  async listAnalysisRuns(filters: AnalysisRunFilters = {}): Promise<AnalysisRunRow[]> {
    return this.executeQuery<AnalysisRunRow>(SQL_QUERIES.analysisRuns.list, [
      filters.domainId ?? null,
      filters.status ?? null,
      filters.limit ?? 100,
      filters.offset ?? 0
    ]);
  }

  async createQueuedRun(domainId: number, _source: AnalysisRunSource = "manual") {
    return this.createAnalysisRun({
      domainId,
      requestPayload: {
        legacy_scaffold: true,
        note: "Compatibility wrapper; V6 requests should use createAnalysisRun."
      },
      status: "queued"
    });
  }

  async attachBullMqJob(runId: number, _bullmqJobId: string) {
    return this.getAnalysisRunById(runId);
  }

  async markProcessing(runId: number) {
    return this.updateAnalysisRunStatus(runId, "processing");
  }

  async markFinished(
    runId: number,
    status: Extract<AnalysisRunStatus, "completed" | "partial_success" | "failed">,
    _errorMessage: string | null
  ) {
    return this.updateAnalysisRunStatus(runId, status);
  }

  async findById(runId: number) {
    return this.getAnalysisRunById(runId);
  }

  async findPreviousSuccessfulRun(domainId: number, currentRunId: number) {
    return this.executeSingleQuery<AnalysisRunRow>(SQL_QUERIES.analysisRuns.findPreviousSuccessfulRun, [
      domainId,
      currentRunId
    ]);
  }
}

export const analysisRunsRepository = new AnalysisRunsRepository();
