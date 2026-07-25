import type { DatabaseExecutor } from "../db/database-executor.js";
import type { AnalysisRunRow } from "../types/database.types.js";
import type {
  DueSchedulerJob,
  SchedulerRequestPolicy
} from "./scheduler.types.js";

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
          schedule.schedule_expression,
          schedule.timezone,
          schedule.request_payload,
          schedule.next_run_at,
          domain.normalized_domain,
          path.category_id,
          path.brand_id,
          path.product_id,
          path.use_context_id
          ,
          (
            workspace.deleted_at IS NULL
            AND owner.status = 'active'
            AND member.user_id IS NOT NULL
          ) AS authorization_valid,
          (
            path.is_active
            AND domain.is_active
            AND (
              path.category_id IS NULL
              OR (
                category.is_active
                AND domain_category.domain_category_id IS NOT NULL
                AND domain_category.is_active
              )
            )
            AND (
              path.brand_id IS NULL
              OR (
                brand.is_active
                AND category_brand.category_brand_id IS NOT NULL
                AND category_brand.is_active
              )
            )
            AND (
              path.product_id IS NULL
              OR (
                product.is_active
                AND brand_product.brand_product_id IS NOT NULL
                AND brand_product.is_active
              )
            )
            AND (
              path.use_context_id IS NULL
              OR (
                use_context.is_active
                AND product_use_context.product_use_context_id IS NOT NULL
                AND product_use_context.is_active
              )
            )
          ) AS hierarchy_valid
        FROM scheduler_jobs AS schedule
        JOIN workspaces AS workspace
          ON workspace.workspace_id = schedule.workspace_id
        JOIN users AS owner ON owner.user_id = schedule.created_by_user_id
        LEFT JOIN workspace_members AS member
          ON member.workspace_id = schedule.workspace_id
         AND member.user_id = schedule.created_by_user_id
        JOIN entity_paths AS path
          ON path.entity_path_id = schedule.starting_entity_path_id
        JOIN domains AS domain
          ON domain.domain_id = path.domain_id
        LEFT JOIN categories AS category ON category.category_id = path.category_id
        LEFT JOIN domain_categories AS domain_category
          ON domain_category.domain_id = path.domain_id
         AND domain_category.category_id = path.category_id
        LEFT JOIN brands AS brand ON brand.brand_id = path.brand_id
        LEFT JOIN category_brands AS category_brand
          ON category_brand.domain_category_id = domain_category.domain_category_id
         AND category_brand.brand_id = path.brand_id
        LEFT JOIN products AS product ON product.product_id = path.product_id
        LEFT JOIN brand_products AS brand_product
          ON brand_product.category_brand_id = category_brand.category_brand_id
         AND brand_product.product_id = path.product_id
        LEFT JOIN use_contexts AS use_context
          ON use_context.use_context_id = path.use_context_id
        LEFT JOIN product_use_contexts AS product_use_context
          ON product_use_context.brand_product_id = brand_product.brand_product_id
         AND product_use_context.use_context_id = path.use_context_id
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

  async createOrReuseRun(input: {
    job: DueSchedulerJob;
    idempotencyKey: string;
    policy: SchedulerRequestPolicy;
  }) {
    const requestPayload = {
      domain: input.job.normalized_domain,
      categoryId: input.job.category_id,
      brandId: input.job.brand_id,
      productId: input.job.product_id,
      useContextId: input.job.use_context_id,
      requestedProvider: input.policy.providerModels[0]!.provider,
      requestedModel: input.policy.providerModels[0]!.model,
      providerModels: input.policy.providerModels,
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
          source,
          status,
          request_payload,
          requested_provider,
          requested_model
        )
        VALUES ($1, $2, $3, $4, 'scheduled', 'queued', $5, $6, $7)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `,
      [
        input.idempotencyKey,
        input.job.created_by_user_id,
        input.job.workspace_id,
        input.job.starting_entity_path_id,
        requestPayload,
        input.policy.providerModels[0]!.provider,
        input.policy.providerModels[0]!.model
      ]
    );
    if (inserted.rows[0]) {
      await this.createProviderModels(
        inserted.rows[0].analysis_run_id,
        input.policy.providerModels
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
          AND requested_provider = $6
          AND requested_model = $7
      `,
      [
        input.idempotencyKey,
        input.job.created_by_user_id,
        input.job.workspace_id,
        input.job.starting_entity_path_id,
        requestPayload,
        input.policy.providerModels[0]!.provider,
        input.policy.providerModels[0]!.model
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing scheduled run violates stable tick identity");
    }
    await this.createProviderModels(
      existing.rows[0].analysis_run_id,
      input.policy.providerModels
    );
    return existing.rows[0];
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

  private async createProviderModels(
    analysisRunId: string,
    providerModels: SchedulerRequestPolicy["providerModels"]
  ) {
    for (const [ordinal, pair] of providerModels.entries()) {
      await this.database.query(
        `
          INSERT INTO analysis_run_provider_models (
            analysis_run_id, provider, model, ordinal
          )
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (analysis_run_id, provider, model) DO NOTHING
        `,
        [analysisRunId, pair.provider, pair.model, ordinal]
      );
    }
  }
}
