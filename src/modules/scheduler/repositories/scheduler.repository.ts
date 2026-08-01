import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  DueSchedulerJob,
} from "../types/scheduler.types.js";

export class SchedulerRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async claimNextDue(now: Date) {
    const result = await this.database.query<DueSchedulerJob>(
      `
        SELECT
          schedule.scheduler_job_id,
          schedule.workspace_id,
          schedule.created_by_user_id,
          schedule.starting_entity_path_id,
          schedule.category_selection_mode,
          schedule.prompt_depth,
          schedule.prompt_policy_version,
          schedule.schedule_expression,
          schedule.timezone,
          schedule.request_payload,
          schedule.next_run_at,
          domain.normalized_domain,
          domain.domain_id,
          path.category_id,
          path.brand_id,
          path.product_id,
          path.use_context_id
        FROM scheduler_jobs AS schedule
        JOIN entity_paths AS path
          ON path.entity_path_id = schedule.starting_entity_path_id
        JOIN domains AS domain
          ON domain.domain_id = path.domain_id
        WHERE schedule.status = 'active'
          AND schedule.next_run_at <= $1
        ORDER BY schedule.next_run_at, schedule.scheduler_job_id
        LIMIT 1
        FOR UPDATE OF schedule SKIP LOCKED
      `,
      [now]
    );
    return result.rows[0] ?? null;
  }

  async activeRequestedCategoryIds(schedulerJobId: string) {
    const result = await this.database.query<{ category_id: string }>(
      `
        SELECT category.category_id
        FROM scheduler_job_requested_categories AS requested
        JOIN categories AS category
          ON category.category_id = requested.category_id AND category.is_active
        WHERE requested.scheduler_job_id = $1
        ORDER BY requested.ordinal
      `,
      [schedulerJobId]
    );
    return result.rows.map((row) => row.category_id);
  }

  async advance(input: {
    schedulerJobId: string;
    dueAt: Date;
    nextRunAt: Date;
    preAnalysisRequestId: string;
  }) {
    const result = await this.database.query<{ scheduler_job_id: string }>(
      `
        UPDATE scheduler_jobs
        SET next_run_at = $3,
            last_enqueued_at = now(),
            last_pre_analysis_request_id = $4,
            updated_at = now()
        WHERE scheduler_job_id = $1
          AND status = 'active'
          AND next_run_at = $2
        RETURNING scheduler_job_id
      `,
      [
        input.schedulerJobId,
        input.dueAt,
        input.nextRunAt,
        input.preAnalysisRequestId
      ]
    );
    return Boolean(result.rows[0]);
  }

  async pause(schedulerJobId: string) {
    await this.database.query(
      `
        UPDATE scheduler_jobs
        SET status = 'paused', updated_at = now()
        WHERE scheduler_job_id = $1 AND status = 'active'
      `,
      [schedulerJobId]
    );
  }
}
