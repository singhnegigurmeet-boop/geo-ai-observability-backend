import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import type {
  FailureRecordRow,
  JsonObject
} from "../../../common/types/database.types.js";
import { ExecutionStateService } from "../../execution/services/execution-state.service.js";
import { ReportAggregationService } from "../../reports/services/report-aggregation.service.js";
import { ReportRepository } from "../../reports/repositories/report.repository.js";

export type RecordWorkerFailure = {
  queueName: string;
  messageId: string;
  aggregateType: string | null;
  aggregateId: string | null;
  attemptNumber: number;
  errorCode: string | null;
  errorMessage: string;
  errorDetails?: JsonObject;
};

export class FailureRecordRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async createOrReuse(input: RecordWorkerFailure) {
    const result = await this.database.query<FailureRecordRow>(
      `
        INSERT INTO failure_records (
          queue_name,
          message_id,
          aggregate_type,
          aggregate_id,
          attempt_number,
          error_code,
          error_message,
          error_details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (queue_name, message_id, attempt_number) DO NOTHING
        RETURNING *
      `,
      [
        input.queueName,
        input.messageId,
        input.aggregateType,
        input.aggregateId,
        input.attemptNumber,
        input.errorCode,
        input.errorMessage.slice(0, 4_000),
        input.errorDetails ?? {}
      ]
    );
    if (result.rows[0]) {
      return result.rows[0];
    }
    const existing = await this.database.query<FailureRecordRow>(
      `
        SELECT *
        FROM failure_records
        WHERE queue_name = $1
          AND message_id = $2
          AND attempt_number = $3
      `,
      [input.queueName, input.messageId, input.attemptNumber]
    );
    if (!existing.rows[0]) {
      throw new Error("Idempotent failure record could not be loaded");
    }
    return existing.rows[0];
  }

  async terminalizeBusinessFailure(input: {
    aggregateType: string | null;
    aggregateId: string | null;
    errorCode: string | null;
    errorMessage: string;
  }) {
    if (!input.aggregateId || !input.aggregateType) return;
    const message = input.errorMessage.slice(0, 1_000);
    if (input.aggregateType === "provider_job") {
      const parent = await this.database.query<{ analysis_run_id: string }>(
        `
          SELECT item.analysis_run_id
          FROM provider_jobs AS job
          JOIN prompt_jobs AS prompt ON prompt.prompt_job_id = job.prompt_job_id
          JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
          JOIN analysis_run_items AS item
            ON item.analysis_run_item_id = llm.analysis_run_item_id
          WHERE job.provider_job_id = $1
        `,
        [input.aggregateId]
      );
      if (parent.rows[0]) {
        await this.database.query(
          "SELECT analysis_run_id FROM analysis_runs WHERE analysis_run_id = $1 FOR UPDATE",
          [parent.rows[0].analysis_run_id]
        );
      }
      await this.database.query(
        `
          UPDATE provider_jobs
          SET status = 'failed',
              completed_at = COALESCE(completed_at, now()),
              error_code = $2,
              error_message = $3,
              updated_at = now()
          WHERE provider_job_id = $1
            AND status IN ('pending', 'queued', 'processing')
        `,
        [input.aggregateId, input.errorCode, message]
      );
      const summary =
        await new ExecutionStateService(this.database).recalculateForProviderJob(
        input.aggregateId
      );
      if (summary) {
        await new ReportAggregationService(
          new ReportRepository(this.database)
        ).createIfReady(summary.analysisRunId);
      }
      return;
    }

    const target =
      input.aggregateType === "prompt_job"
        ? {
            table: "prompt_jobs",
            id: "prompt_job_id",
            status: "'failed'::job_status",
            runSql: `
              SELECT item.analysis_run_id
              FROM prompt_jobs AS target
              JOIN llm_runs AS llm ON llm.llm_run_id = target.llm_run_id
              JOIN analysis_run_items AS item
                ON item.analysis_run_item_id = llm.analysis_run_item_id
              WHERE target.prompt_job_id = $1
            `
          }
        : input.aggregateType === "llm_run"
          ? {
              table: "llm_runs",
              id: "llm_run_id",
              status: "'failed'::analysis_execution_status",
              runSql: `
                SELECT item.analysis_run_id
                FROM llm_runs AS target
                JOIN analysis_run_items AS item
                  ON item.analysis_run_item_id = target.analysis_run_item_id
                WHERE target.llm_run_id = $1
              `
            }
          : input.aggregateType === "analysis_run_item"
            ? {
                table: "analysis_run_items",
                id: "analysis_run_item_id",
                status: "'failed'::analysis_execution_status",
                runSql:
                  "SELECT analysis_run_id FROM analysis_run_items WHERE analysis_run_item_id = $1"
              }
            : null;
    if (target) {
      const run = await this.database.query<{ analysis_run_id: string }>(
        target.runSql,
        [input.aggregateId]
      );
      await this.database.query(
        `
          UPDATE ${target.table}
          SET status = ${target.status},
              completed_at = COALESCE(completed_at, now()),
              error_code = $2,
              error_message = $3,
              updated_at = now()
          WHERE ${target.id} = $1
            AND status::text NOT IN ('succeeded', 'completed', 'cancelled')
        `,
        [input.aggregateId, input.errorCode, message]
      );
      if (run.rows[0]) {
        await new ExecutionStateService(this.database).recalculateRun(
          run.rows[0].analysis_run_id
        );
        await new ReportAggregationService(
          new ReportRepository(this.database)
        ).createIfReady(run.rows[0].analysis_run_id);
      }
      return;
    }

    if (input.aggregateType === "analysis_run") {
      await this.database.query(
        `
          UPDATE analysis_runs
          SET status = 'failed',
              completed_at = COALESCE(completed_at, now()),
              error_code = $2,
              error_message = $3,
              updated_at = now()
          WHERE analysis_run_id = $1
            AND status IN ('queued', 'processing')
        `,
        [input.aggregateId, input.errorCode, message]
      );
    }
  }

  async createAndTerminalize(input: RecordWorkerFailure) {
    const transactionPool = this.database as DatabaseExecutor &
      Partial<TransactionPool>;
    if (typeof transactionPool.connect === "function") {
      return inTransaction(transactionPool as DatabaseExecutor & TransactionPool, async (client) => {
        const repository = new FailureRecordRepository(client);
        const record = await repository.createOrReuse(input);
        await repository.terminalizeBusinessFailure({
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage
        });
        return record;
      });
    }
    const record = await this.createOrReuse(input);
    await this.terminalizeBusinessFailure({
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage
    });
    return record;
  }
}
