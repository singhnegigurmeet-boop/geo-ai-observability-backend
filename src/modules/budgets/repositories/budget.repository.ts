import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  BudgetPolicyRow,
  ProviderName,
  TokenUsageRow
} from "../../../common/types/database.types.js";
import type {
  ApplicableBudgetPolicy,
  BudgetConsumption,
  UsageEstimate
} from "../types/budget.types.js";

export class BudgetRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async lockApplicablePolicies(input: {
    provider: ProviderName;
    model: string;
    workspaceId: string | null;
    userId: string | null;
    anonymousSessionId: string | null;
    analysisRunId: string | null;
  }): Promise<ApplicableBudgetPolicy[]> {
    const result = await this.database.query<BudgetPolicyRow>(
      `
        SELECT *
        FROM budget_policies
        WHERE provider = $1
          AND (model IS NULL OR model = $2)
          AND is_enabled
          AND (
            budget_scope = 'platform_default'
            OR (
              budget_scope = 'workspace'
              AND workspace_id = $3
              AND $4::bigint IS NOT NULL
            )
            OR (
              budget_scope = 'user'
              AND user_id = $4
            )
            OR (
              budget_scope = 'anonymous_session'
              AND anonymous_session_id = $5
              AND $4::bigint IS NULL
            )
            OR (
              budget_scope = 'analysis_run'
              AND analysis_run_id = $6
              AND $6::bigint IS NOT NULL
            )
          )
        ORDER BY budget_policy_id
        FOR UPDATE
      `,
      [
        input.provider,
        input.model,
        input.workspaceId,
        input.userId,
        input.anonymousSessionId,
        input.analysisRunId
      ]
    );
    return result.rows.map((row) => ({
      budgetPolicyId: row.budget_policy_id,
      budgetScope: row.budget_scope,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      anonymousSessionId: row.anonymous_session_id,
      analysisRunId: row.analysis_run_id,
      provider: row.provider,
      model: row.model,
      limitMode: row.limit_mode,
      windowSeconds: row.window_seconds,
      tokenLimit: row.token_limit,
      costLimitMicros: row.cost_limit_micros,
      currencyCode: row.currency_code
    }));
  }

  async consumption(
    policy: ApplicableBudgetPolicy
  ): Promise<BudgetConsumption> {
    const result = await this.database.query<BudgetConsumption>(
      `
        WITH accounted_usage AS (
          SELECT DISTINCT ON (usage.provider_job_id)
            usage.provider_job_id,
            usage.total_tokens,
            COALESCE(usage.cost_micros, 0) AS cost_micros
          FROM token_usage AS usage
          JOIN provider_jobs AS provider_job
            ON provider_job.provider_job_id = usage.provider_job_id
          LEFT JOIN prompt_jobs AS prompt
            ON prompt.prompt_job_id = provider_job.prompt_job_id
          LEFT JOIN llm_runs AS llm
            ON llm.llm_run_id = prompt.llm_run_id
          LEFT JOIN analysis_run_items AS item
            ON item.analysis_run_item_id = llm.analysis_run_item_id
          LEFT JOIN analysis_runs AS run
            ON run.analysis_run_id = item.analysis_run_id
          LEFT JOIN hierarchy_discovery_jobs AS discovery
            ON discovery.hierarchy_discovery_job_id=provider_job.discovery_job_id
          LEFT JOIN pre_analysis_requests AS request
            ON request.pre_analysis_request_id=discovery.pre_analysis_request_id
          WHERE provider_job.provider = $1
            AND ($2::text IS NULL OR provider_job.model = $2)
            AND usage.recorded_at >=
                now() - ($3::integer * interval '1 second')
            AND (
              $4::text = 'platform_default'
              OR (
                $4::text = 'workspace'
                AND COALESCE(run.workspace_id,request.workspace_id) = $5::bigint
              )
              OR (
                $4::text = 'user'
                AND COALESCE(run.user_id,request.user_id) = $6::bigint
              )
              OR (
                $4::text = 'anonymous_session'
                AND COALESCE(run.anonymous_session_id,request.anonymous_session_id) = $7::bigint
                AND COALESCE(run.user_id,request.user_id) IS NULL
              )
              OR (
                $4::text = 'analysis_run'
                AND run.analysis_run_id = $8::bigint
              )
            )
          ORDER BY
            usage.provider_job_id,
            CASE usage.usage_kind WHEN 'actual' THEN 0 ELSE 1 END
        )
        SELECT
          COALESCE(sum(total_tokens), 0)::text AS "totalTokens",
          COALESCE(sum(cost_micros), 0)::text AS "costMicros"
        FROM accounted_usage
      `,
      [
        policy.provider,
        policy.model,
        policy.windowSeconds,
        policy.budgetScope,
        policy.workspaceId,
        policy.userId,
        policy.anonymousSessionId,
        policy.analysisRunId
      ]
    );
    return result.rows[0] as BudgetConsumption;
  }

  async createOrReuseEstimate(input: {
    providerJobId: string;
    estimate: UsageEstimate;
  }) {
    const idempotencyKey = `token_usage:${input.providerJobId}:estimated`;
    const inserted = await this.database.query<TokenUsageRow>(
      `
        INSERT INTO token_usage (
          idempotency_key,
          provider_job_id,
          usage_kind,
          input_tokens,
          output_tokens,
          cached_tokens,
          reasoning_tokens,
          cost_micros
        )
        VALUES ($1, $2, 'estimated', $3, $4, 0, 0, $5)
        ON CONFLICT (provider_job_id, usage_kind) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.providerJobId,
        input.estimate.inputTokens,
        input.estimate.outputTokens,
        input.estimate.costMicros
      ]
    );
    if (inserted.rows[0]) {
      return inserted.rows[0];
    }
    const existing = await this.database.query<TokenUsageRow>(
      `
        SELECT *
        FROM token_usage
        WHERE provider_job_id = $1
          AND usage_kind = 'estimated'
          AND idempotency_key = $2
          AND input_tokens = $3
          AND output_tokens = $4
          AND cost_micros = $5
      `,
      [
        input.providerJobId,
        idempotencyKey,
        input.estimate.inputTokens,
        input.estimate.outputTokens,
        input.estimate.costMicros
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing estimated usage violates stable reservation");
    }
    return existing.rows[0];
  }
}
