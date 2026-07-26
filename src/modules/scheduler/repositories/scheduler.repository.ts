import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import { AnalysisRunProviderModelRepository } from "../../providers/repositories/analysis-run-provider-model.repository.js";
import type { AnalysisRunRow } from "../../../common/types/database.types.js";
import type {
  DueSchedulerJob,
  SchedulerRequestPolicy
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

  async createOrReuseRun(input: {
    job: DueSchedulerJob;
    idempotencyKey: string;
    policy: SchedulerRequestPolicy;
  }) {
    const requestPayload = {
      ...input.policy.canonicalRequestPayload,
      schedulerJobId: input.job.scheduler_job_id,
      scheduledDueAt: input.job.next_run_at.toISOString()
    };
    const inserted = await this.database.query<AnalysisRunRow>(
      `
        INSERT INTO analysis_runs (
          idempotency_key,
          user_id,
          workspace_id,
          starting_entity_path_id,
          category_selection_mode,
          prompt_depth,
          prompt_policy_version,
          source,
          status,
          request_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', 'queued', $8)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `,
      [
        input.idempotencyKey,
        input.job.created_by_user_id,
        input.job.workspace_id,
        input.job.starting_entity_path_id,
        input.job.category_selection_mode,
        input.job.prompt_depth,
        input.job.prompt_policy_version,
        requestPayload
      ]
    );
    if (inserted.rows[0]) {
      await new AnalysisRunProviderModelRepository(
        this.database
      ).createOrReuse(
        inserted.rows[0].analysis_run_id,
        input.policy.providerModels
      );
      await this.createRunRequestedCategories(
        inserted.rows[0].analysis_run_id,
        input.policy.categoryIds
      );
      return inserted.rows[0];
    }
    const existing = await this.database.query<AnalysisRunRow>(
      `
        SELECT *
        FROM analysis_runs
        WHERE idempotency_key = $1
          AND user_id = $2
          AND workspace_id = $3
          AND starting_entity_path_id = $4
          AND source = 'scheduled'
          AND request_payload = $5::jsonb
      `,
      [
        input.idempotencyKey,
        input.job.created_by_user_id,
        input.job.workspace_id,
        input.job.starting_entity_path_id,
        requestPayload
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing scheduled run violates stable tick identity");
    }
    await new AnalysisRunProviderModelRepository(
      this.database
    ).createOrReuse(
      existing.rows[0].analysis_run_id,
      input.policy.providerModels
    );
    await this.createRunRequestedCategories(
      existing.rows[0].analysis_run_id,
      input.policy.categoryIds
    );
    return existing.rows[0];
  }

  private async createRunRequestedCategories(
    analysisRunId: string,
    categoryIds: readonly string[]
  ) {
    for (const [ordinal, categoryId] of categoryIds.entries()) {
      await this.database.query(
        `
          INSERT INTO analysis_run_requested_categories (
            analysis_run_id, category_id, ordinal
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (analysis_run_id, category_id) DO NOTHING
        `,
        [analysisRunId, categoryId, ordinal]
      );
    }
  }

  async advance(input: {
    schedulerJobId: string;
    dueAt: Date;
    nextRunAt: Date;
    analysisRunId: string;
  }) {
    const result = await this.database.query<{ scheduler_job_id: string }>(
      `
        UPDATE scheduler_jobs
        SET next_run_at = $3,
            last_enqueued_at = now(),
            last_analysis_run_id = $4,
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
        input.analysisRunId
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
