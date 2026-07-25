import type { DatabaseExecutor } from "../db/database-executor.js";
import type { AnalysisExecutionStatus } from "../types/database.types.js";

export type RunExecutionSummary = {
  analysisRunId: string;
  status: AnalysisExecutionStatus;
  providerJobCount: number;
  nonterminalCount: number;
  succeededCount: number;
  failedCount: number;
  invalidCount: number;
  pausedBudgetCount: number;
  cancelledCount: number;
  scoredCount: number;
};

export class ExecutionStateService {
  constructor(private readonly database: DatabaseExecutor) {}

  async recalculateForProviderJob(providerJobId: string) {
    const result = await this.database.query<{ analysis_run_id: string }>(
      `
        SELECT item.analysis_run_id
        FROM provider_jobs AS job
        JOIN prompt_jobs AS prompt ON prompt.prompt_job_id = job.prompt_job_id
        JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
        JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        WHERE job.provider_job_id = $1
      `,
      [providerJobId]
    );
    const runId = result.rows[0]?.analysis_run_id;
    return runId ? this.recalculateRun(runId) : null;
  }

  async recalculateRun(analysisRunId: string): Promise<RunExecutionSummary> {
    await this.lockTree(analysisRunId);
    await this.recalculatePrompts(analysisRunId);
    await this.recalculateLlmRuns(analysisRunId);
    await this.recalculateItems(analysisRunId);
    const summary = await this.summary(analysisRunId);
    await this.recalculateRunRow(summary);
    return { ...summary, status: await this.currentStatus(analysisRunId) };
  }

  private async lockTree(analysisRunId: string) {
    await this.database.query(
      "SELECT analysis_run_id FROM analysis_runs WHERE analysis_run_id = $1 FOR UPDATE",
      [analysisRunId]
    );
    await this.database.query(
      `SELECT analysis_run_item_id FROM analysis_run_items
       WHERE analysis_run_id = $1 ORDER BY analysis_run_item_id FOR UPDATE`,
      [analysisRunId]
    );
    await this.database.query(
      `SELECT llm.llm_run_id
       FROM llm_runs AS llm
       JOIN analysis_run_items AS item
         ON item.analysis_run_item_id = llm.analysis_run_item_id
       WHERE item.analysis_run_id = $1
       ORDER BY llm.llm_run_id
       FOR UPDATE OF llm`,
      [analysisRunId]
    );
    await this.database.query(
      `SELECT prompt.prompt_job_id
       FROM prompt_jobs AS prompt
       JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
       JOIN analysis_run_items AS item
         ON item.analysis_run_item_id = llm.analysis_run_item_id
       WHERE item.analysis_run_id = $1
       ORDER BY prompt.prompt_job_id
       FOR UPDATE OF prompt`,
      [analysisRunId]
    );
    await this.database.query(
      `SELECT job.provider_job_id
       FROM provider_jobs AS job
       JOIN prompt_jobs AS prompt ON prompt.prompt_job_id = job.prompt_job_id
       JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
       JOIN analysis_run_items AS item
         ON item.analysis_run_item_id = llm.analysis_run_item_id
       WHERE item.analysis_run_id = $1
       ORDER BY job.provider_job_id
       FOR UPDATE OF job`,
      [analysisRunId]
    );
  }

  private recalculatePrompts(analysisRunId: string) {
    return this.database.query(
      `
        WITH states AS (
          SELECT
            prompt.prompt_job_id,
            count(job.*)::integer AS total,
            count(*) FILTER (
              WHERE job.status IN ('pending', 'queued', 'processing')
            )::integer AS active,
            count(*) FILTER (WHERE job.status = 'succeeded')::integer AS succeeded,
            count(*) FILTER (WHERE job.status = 'failed')::integer AS failed,
            count(*) FILTER (WHERE job.status = 'paused_budget')::integer AS paused,
            count(*) FILTER (WHERE job.status = 'cancelled')::integer AS cancelled
          FROM prompt_jobs AS prompt
          JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
          JOIN analysis_run_items AS item
            ON item.analysis_run_item_id = llm.analysis_run_item_id
          LEFT JOIN provider_jobs AS job
            ON job.prompt_job_id = prompt.prompt_job_id
          WHERE item.analysis_run_id = $1
          GROUP BY prompt.prompt_job_id
        )
        UPDATE prompt_jobs AS prompt
        SET status = CASE
              WHEN prompt.status = 'cancelled' THEN 'cancelled'::job_status
              WHEN states.total = 0 THEN prompt.status
              WHEN states.active > 0 THEN 'processing'::job_status
              WHEN states.paused > 0 THEN 'paused_budget'::job_status
              WHEN states.succeeded = states.total THEN 'succeeded'::job_status
              WHEN states.cancelled = states.total THEN 'cancelled'::job_status
              ELSE 'failed'::job_status
            END,
            completed_at = CASE
              WHEN states.total > 0
               AND states.active = 0
               AND states.paused = 0
              THEN COALESCE(prompt.completed_at, now())
              ELSE NULL
            END,
            error_code = CASE
              WHEN states.failed > 0 THEN 'PROVIDER_WORK_INCOMPLETE'
              ELSE prompt.error_code
            END,
            updated_at = now()
        FROM states
        WHERE prompt.prompt_job_id = states.prompt_job_id
      `,
      [analysisRunId]
    );
  }

  private recalculateLlmRuns(analysisRunId: string) {
    return this.database.query(
      `
        WITH states AS (
          SELECT
            llm.llm_run_id,
            count(*)::integer AS total,
            count(*) FILTER (
              WHERE prompt.status IN ('pending', 'queued', 'processing')
            )::integer AS active,
            count(*) FILTER (WHERE prompt.status = 'succeeded')::integer AS succeeded,
            count(*) FILTER (WHERE prompt.status = 'paused_budget')::integer AS paused,
            count(*) FILTER (WHERE prompt.status = 'cancelled')::integer AS cancelled
          FROM llm_runs AS llm
          JOIN analysis_run_items AS item
            ON item.analysis_run_item_id = llm.analysis_run_item_id
          JOIN prompt_jobs AS prompt ON prompt.llm_run_id = llm.llm_run_id
          WHERE item.analysis_run_id = $1
          GROUP BY llm.llm_run_id
        )
        UPDATE llm_runs AS llm
        SET status = CASE
              WHEN llm.status = 'cancelled' THEN 'cancelled'::analysis_execution_status
              WHEN states.active > 0 THEN 'processing'::analysis_execution_status
              WHEN states.paused > 0 THEN 'paused_budget'::analysis_execution_status
              WHEN states.succeeded = states.total THEN 'completed'::analysis_execution_status
              WHEN states.succeeded > 0 THEN 'partial_success'::analysis_execution_status
              WHEN states.cancelled = states.total THEN 'cancelled'::analysis_execution_status
              ELSE 'failed'::analysis_execution_status
            END,
            completed_at = CASE
              WHEN states.active = 0 AND states.paused = 0
              THEN COALESCE(llm.completed_at, now())
              ELSE NULL
            END,
            updated_at = now()
        FROM states
        WHERE llm.llm_run_id = states.llm_run_id
      `,
      [analysisRunId]
    );
  }

  private recalculateItems(analysisRunId: string) {
    return this.database.query(
      `
        WITH states AS (
          SELECT
            item.analysis_run_item_id,
            count(*)::integer AS total,
            count(*) FILTER (
              WHERE llm.status IN ('queued', 'processing')
            )::integer AS active,
            count(*) FILTER (WHERE llm.status = 'completed')::integer AS succeeded,
            count(*) FILTER (WHERE llm.status = 'partial_success')::integer AS partial,
            count(*) FILTER (WHERE llm.status = 'paused_budget')::integer AS paused,
            count(*) FILTER (WHERE llm.status = 'cancelled')::integer AS cancelled
          FROM analysis_run_items AS item
          JOIN llm_runs AS llm
            ON llm.analysis_run_item_id = item.analysis_run_item_id
          WHERE item.analysis_run_id = $1
          GROUP BY item.analysis_run_item_id
        )
        UPDATE analysis_run_items AS item
        SET status = CASE
              WHEN item.status = 'cancelled' THEN 'cancelled'::analysis_execution_status
              WHEN states.active > 0 THEN 'processing'::analysis_execution_status
              WHEN states.paused > 0 THEN 'paused_budget'::analysis_execution_status
              WHEN states.succeeded = states.total THEN 'completed'::analysis_execution_status
              WHEN states.succeeded > 0 OR states.partial > 0
                THEN 'partial_success'::analysis_execution_status
              WHEN states.cancelled = states.total THEN 'cancelled'::analysis_execution_status
              ELSE 'failed'::analysis_execution_status
            END,
            completed_at = CASE
              WHEN states.active = 0 AND states.paused = 0
              THEN COALESCE(item.completed_at, now())
              ELSE NULL
            END,
            updated_at = now()
        FROM states
        WHERE item.analysis_run_item_id = states.analysis_run_item_id
      `,
      [analysisRunId]
    );
  }

  private async summary(analysisRunId: string) {
    const result = await this.database.query<Omit<RunExecutionSummary, "status">>(
      `
        SELECT
          $1::text AS "analysisRunId",
          count(job.*)::integer AS "providerJobCount",
          count(*) FILTER (
            WHERE job.status IN ('pending', 'queued', 'processing')
          )::integer AS "nonterminalCount",
          count(*) FILTER (WHERE job.status = 'succeeded')::integer AS "succeededCount",
          count(*) FILTER (WHERE job.status = 'failed')::integer AS "failedCount",
          count(*) FILTER (
            WHERE result.status = 'invalid'
          )::integer AS "invalidCount",
          count(*) FILTER (
            WHERE job.status = 'paused_budget'
          )::integer AS "pausedBudgetCount",
          count(*) FILTER (WHERE job.status = 'cancelled')::integer AS "cancelledCount",
          count(score.*)::integer AS "scoredCount"
        FROM analysis_run_items AS item
        LEFT JOIN llm_runs AS llm
          ON llm.analysis_run_item_id = item.analysis_run_item_id
        LEFT JOIN prompt_jobs AS prompt ON prompt.llm_run_id = llm.llm_run_id
        LEFT JOIN provider_jobs AS job ON job.prompt_job_id = prompt.prompt_job_id
        LEFT JOIN provider_results AS result
          ON result.provider_job_id = job.provider_job_id
        LEFT JOIN provider_scores AS score
          ON score.provider_result_id = result.provider_result_id
         AND score.scoring_version = 'backend-v1'
        WHERE item.analysis_run_id = $1::bigint
      `,
      [analysisRunId]
    );
    return result.rows[0] as Omit<RunExecutionSummary, "status">;
  }

  private async recalculateRunRow(
    summary: Omit<RunExecutionSummary, "status">
  ) {
    const itemResult = await this.database.query<{
      total: number;
      active: number;
      completed: number;
      partial: number;
      failed: number;
      paused: number;
      cancelled: number;
    }>(
      `
        SELECT
          count(*)::integer AS total,
          count(*) FILTER (WHERE status IN ('queued', 'processing'))::integer AS active,
          count(*) FILTER (WHERE status = 'completed')::integer AS completed,
          count(*) FILTER (WHERE status = 'partial_success')::integer AS partial,
          count(*) FILTER (WHERE status = 'failed')::integer AS failed,
          count(*) FILTER (WHERE status = 'paused_budget')::integer AS paused,
          count(*) FILTER (WHERE status = 'cancelled')::integer AS cancelled
        FROM analysis_run_items
        WHERE analysis_run_id = $1
      `,
      [summary.analysisRunId]
    );
    const items = itemResult.rows[0]!;
    const status: AnalysisExecutionStatus =
      items.active > 0
        ? "processing"
        : items.paused > 0
          ? "paused_budget"
          : items.total > 0 && items.completed === items.total
            ? "processing"
            : items.completed > 0 || items.partial > 0
              ? "partial_success"
              : items.total > 0 && items.cancelled === items.total
                ? "cancelled"
                : items.total > 0 && items.failed === items.total
                  ? "failed"
                  : "processing";
    return this.database.query(
      `
        UPDATE analysis_runs
        SET status = $2::analysis_execution_status,
            completed_at = CASE
              WHEN $2::analysis_execution_status IN (
                'partial_success', 'failed', 'cancelled'
              )
              THEN COALESCE(completed_at, now())
              ELSE NULL
            END,
            updated_at = now()
        WHERE analysis_run_id = $1
          AND status <> 'cancelled'
      `,
      [summary.analysisRunId, status]
    );
  }

  private async currentStatus(analysisRunId: string) {
    const result = await this.database.query<{ status: AnalysisExecutionStatus }>(
      "SELECT status FROM analysis_runs WHERE analysis_run_id = $1",
      [analysisRunId]
    );
    return result.rows[0]!.status;
  }
}
