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
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { requiresScoring } from "../../prompts/policies/prompt-policy.registry.js";
import { SCORING_VERSION } from "../../scoring/types/score.types.js";
import {
  resolvePermanentFailureRoute,
  type PermanentFailureRoute
} from "../services/permanent-failure-routing.service.js";

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
    queueName: string;
    aggregateType: string | null;
    aggregateId: string | null;
    errorCode: string | null;
    errorMessage: string;
  }) {
    if (!input.aggregateId || !input.aggregateType) return;
    const route = resolvePermanentFailureRoute(
      input.aggregateType,
      input.queueName
    );
    const safeCode = input.errorCode ?? "PERMANENT_WORKER_FAILURE";
    const safeMessage = safeFailureMessage(route);

    switch (route) {
      case "analysis_run":
        await this.terminalizeAnalysisRun(
          input.aggregateId,
          safeCode,
          safeMessage
        );
        return;
      case "analysis_run_item":
      case "llm_run":
      case "prompt_job":
        await this.terminalizeIntermediate(
          route,
          input.aggregateId,
          safeCode,
          safeMessage
        );
        return;
      case "provider_job":
        await this.terminalizeProviderJob(
          input.aggregateId,
          safeCode,
          safeMessage
        );
        return;
      case "normal_scoring":
        await this.terminalizeNormalScoring(input.aggregateId);
        return;
      case "classification_job":
        await this.terminalizeClassificationJob(
          input.aggregateId,
          safeCode,
          safeMessage
        );
        return;
      case "classification_result":
        await this.terminalizeClassificationResult(
          input.aggregateId,
          safeCode,
          safeMessage
        );
        return;
      case "scheduler_job":
      case "notification":
        // These aggregates already own their terminal state outside the generic
        // retry runtime. Their failure record is the authoritative outcome.
        return;
    }
  }

  private async terminalizeAnalysisRun(
    analysisRunId: string,
    errorCode: string,
    errorMessage: string
  ) {
    const run = await this.database.query<{
      status: string;
      classification_completed_empty: boolean;
    }>(
      `SELECT
         run.status,
         EXISTS (
           SELECT 1
           FROM domain_category_classification_jobs AS classification
           WHERE classification.analysis_run_id = run.analysis_run_id
             AND classification.status = 'completed_empty'
         ) AS classification_completed_empty
       FROM analysis_runs AS run
       WHERE run.analysis_run_id = $1
       FOR UPDATE OF run`,
      [analysisRunId]
    );
    if (!run.rows[0]) return;
    if (!run.rows[0].classification_completed_empty) {
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
        [analysisRunId, errorCode, errorMessage]
      );
    }
    await this.requestReportAggregation(analysisRunId);
  }

  private async terminalizeIntermediate(
    route: Extract<
      PermanentFailureRoute,
      "analysis_run_item" | "llm_run" | "prompt_job"
    >,
    aggregateId: string,
    errorCode: string,
    errorMessage: string
  ) {
    const target =
      route === "prompt_job"
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
        : route === "llm_run"
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
          : {
              table: "analysis_run_items",
              id: "analysis_run_item_id",
              status: "'failed'::analysis_execution_status",
              runSql:
                "SELECT analysis_run_id FROM analysis_run_items WHERE analysis_run_item_id = $1"
            };
    const run = await this.database.query<{ analysis_run_id: string }>(
      target.runSql,
      [aggregateId]
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
      [aggregateId, errorCode, errorMessage]
    );
    if (!run.rows[0]) return;
    await new ExecutionStateService(this.database).recalculateRun(
      run.rows[0].analysis_run_id
    );
    await this.requestReportAggregation(run.rows[0].analysis_run_id);
  }

  private async terminalizeProviderJob(
    providerJobId: string,
    errorCode: string,
    errorMessage: string
  ) {
    const parent = await this.database.query<{
      analysis_run_id: string;
      classification_job_id: string | null;
    }>(
      `
        SELECT
          COALESCE(item.analysis_run_id, classification.analysis_run_id)
            AS analysis_run_id,
          job.classification_job_id
        FROM provider_jobs AS job
        LEFT JOIN prompt_jobs AS prompt
          ON prompt.prompt_job_id = job.prompt_job_id
        LEFT JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
        LEFT JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        LEFT JOIN domain_category_classification_jobs AS classification
          ON classification.domain_category_classification_job_id =
             job.classification_job_id
        WHERE job.provider_job_id = $1
      `,
      [providerJobId]
    );
    if (parent.rows[0]) {
      await this.database.query(
        `SELECT analysis_run_id FROM analysis_runs
         WHERE analysis_run_id = $1 FOR UPDATE`,
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
      [providerJobId, errorCode, errorMessage]
    );
    if (parent.rows[0]?.classification_job_id) {
      await this.terminalizeClassification(
        parent.rows[0].classification_job_id,
        parent.rows[0].analysis_run_id,
        errorCode,
        errorMessage
      );
      return;
    }
    const summary =
      await new ExecutionStateService(this.database).recalculateForProviderJob(
        providerJobId
      );
    if (summary) {
      await this.requestReportAggregation(summary.analysisRunId);
    }
  }

  private async terminalizeNormalScoring(providerResultId: string) {
    const state = await this.database.query<{
      analysis_run_id: string;
      result_status: string;
      context_validation_status: string;
      prompt_type: Parameters<typeof requiresScoring>[0];
      provider_score_id: string | null;
    }>(
      `
        SELECT
          item.analysis_run_id,
          result.status AS result_status,
          result.context_validation_status,
          prompt.prompt_type,
          score.provider_score_id
        FROM provider_results AS result
        JOIN provider_jobs AS job
          ON job.provider_job_id = result.provider_job_id
         AND job.job_kind = 'normal_prompt'
        JOIN prompt_jobs AS prompt
          ON prompt.prompt_job_id = job.prompt_job_id
        JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
        JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        LEFT JOIN provider_scores AS score
          ON score.provider_result_id = result.provider_result_id
         AND score.scoring_version = $2
        WHERE result.provider_result_id = $1
        FOR UPDATE OF result
      `,
      [providerResultId, SCORING_VERSION]
    );
    const row = state.rows[0];
    if (!row) return;
    if (
      row.result_status !== "valid" ||
      row.context_validation_status !== "valid" ||
      !requiresScoring(row.prompt_type) ||
      row.provider_score_id !== null
    ) {
      await this.requestReportAggregation(row.analysis_run_id);
      return;
    }
    // The failure record inserted by createAndTerminalize is the immutable
    // scoring-stage terminal marker. Provider evidence remains untouched.
    await this.requestReportAggregation(row.analysis_run_id);
  }

  private async terminalizeClassificationJob(
    classificationJobId: string,
    errorCode: string,
    errorMessage: string
  ) {
    const classification = await this.database.query<{
      analysis_run_id: string;
    }>(
      `
        SELECT analysis_run_id
        FROM domain_category_classification_jobs
        WHERE domain_category_classification_job_id = $1
      `,
      [classificationJobId]
    );
    if (!classification.rows[0]) return;
    await this.terminalizeClassification(
      classificationJobId,
      classification.rows[0].analysis_run_id,
      errorCode,
      errorMessage
    );
  }

  private async terminalizeClassificationResult(
    providerResultId: string,
    errorCode: string,
    errorMessage: string
  ) {
    const classification = await this.database.query<{
      classification_job_id: string;
      analysis_run_id: string;
    }>(
      `
        SELECT
          job.classification_job_id,
          classification.analysis_run_id
        FROM provider_results AS result
        JOIN provider_jobs AS job
          ON job.provider_job_id = result.provider_job_id
         AND job.job_kind = 'domain_category_classification'
        JOIN domain_category_classification_jobs AS classification
          ON classification.domain_category_classification_job_id =
             job.classification_job_id
        WHERE result.provider_result_id = $1
      `,
      [providerResultId]
    );
    if (!classification.rows[0]) return;
    await this.terminalizeClassification(
      classification.rows[0].classification_job_id,
      classification.rows[0].analysis_run_id,
      errorCode,
      errorMessage
    );
  }

  private requestReportAggregation(analysisRunId: string) {
    return new ReportAggregationService(
      new ReportRepository(this.database)
    ).createIfReady(analysisRunId);
  }

  private async terminalizeClassification(
    classificationJobId: string,
    analysisRunId: string,
    errorCode: string | null,
    errorMessage: string
  ) {
    await this.database.query(
      `
        UPDATE domain_category_classification_jobs
        SET status = 'failed',
            error_code = $2,
            error_message = $3,
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
        WHERE domain_category_classification_job_id = $1
          AND status IN ('queued', 'processing')
      `,
      [classificationJobId, errorCode, errorMessage]
    );
    await new OutboxEventWriterRepository(this.database).createOrReuse({
      eventKey:
        `analysis_run.classification_failed:${analysisRunId}:${classificationJobId}`,
      eventType: "analysis_run.created",
      eventVersion: 1,
      aggregateType: "analysis_run",
      aggregateId: analysisRunId,
      headers: { queueName: "analysis_run_queue" },
      payload: { analysisRunId }
    });
  }

  async createAndTerminalize(input: RecordWorkerFailure) {
    const transactionPool = this.database as DatabaseExecutor &
      Partial<TransactionPool>;
    if (typeof transactionPool.connect === "function") {
      return inTransaction(transactionPool as DatabaseExecutor & TransactionPool, async (client) => {
        const repository = new FailureRecordRepository(client);
        const record = await repository.createOrReuse(input);
        await repository.terminalizeBusinessFailure({
          queueName: input.queueName,
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
      queueName: input.queueName,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage
    });
    return record;
  }
}

function safeFailureMessage(route: PermanentFailureRoute) {
  switch (route) {
    case "analysis_run":
      return "Analysis run processing exhausted its retry policy.";
    case "analysis_run_item":
      return "Analysis item processing exhausted its retry policy.";
    case "llm_run":
      return "Prompt planning exhausted its retry policy.";
    case "prompt_job":
      return "Prompt execution exhausted its retry policy.";
    case "provider_job":
      return "Provider execution exhausted its retry policy.";
    case "normal_scoring":
      return "Provider scoring exhausted its retry policy.";
    case "classification_job":
    case "classification_result":
      return "Domain classification exhausted its retry policy.";
    case "scheduler_job":
      return "Scheduled analysis processing failed.";
    case "notification":
      return "Notification delivery exhausted its retry policy.";
  }
}
