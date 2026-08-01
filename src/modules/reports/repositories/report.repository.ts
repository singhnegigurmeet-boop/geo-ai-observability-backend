import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import { isDeepStrictEqual } from "node:util";
import type {
  AnalysisExecutionStatus,
  ContextValidationStatus,
  EntityPathType,
  JobStatus,
  JsonObject,
  PromptDepth,
  PromptType,
  ProviderName,
  ProviderResultStatus,
  ReportRow,
  ReportStatus
} from "../../../common/types/database.types.js";
import type {
  ExpectedPlanItem,
  ExpectedPlanProviderModel,
  ExpectedPlanRun
} from "../services/expected-execution-plan.service.js";

export type ReportExecutionRecord = {
  analysis_run_item_id: string;
  item_ordinal: number;
  prompt_job_id: string;
  prompt_type: PromptType;
  prompt_depth: PromptDepth;
  business_prompt_version: string;
  response_contract_version: string;
  entity_path_id: string;
  category_id: string | null;
  category_name: string | null;
  provider_job_id: string;
  provider_result_id: string | null;
  provider_score_id: string | null;
  provider: ProviderName;
  model: string;
  model_profile_version?: string;
  provider_instruction_profile?: string;
  structured_output_mode?: string;
  provider_job_status: JobStatus;
  error_code: string | null;
  result_status: ProviderResultStatus | null;
  context_validation_status: ContextValidationStatus | null;
  validated_response: JsonObject | null;
  validation_errors: JsonObject[];
  metric_type: "visibility" | "ranking" | "competitive_pressure" | null;
  scoring_version: string | null;
  score: string | null;
  score_components: JsonObject | null;
  scoring_failure_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: string | null;
  estimated_input_tokens?: number | null;
  estimated_output_tokens?: number | null;
  estimated_cost_micros?: string | null;
};

export type ReportMaterializationRecord = {
  analysis_run_item_id: string;
  item_ordinal: number;
  item_status: AnalysisExecutionStatus;
  entity_path_id: string;
  category_id: string | null;
  category_name: string | null;
  llm_run_id: string | null;
  llm_run_status: AnalysisExecutionStatus | null;
  llm_error_code: string | null;
  prompt_job_id: string | null;
  prompt_type: PromptType | null;
  prompt_depth: PromptDepth | null;
  business_prompt_version: string | null;
  response_contract_version: string | null;
  prompt_job_status: JobStatus | null;
  prompt_error_code: string | null;
  provider_job_id: string | null;
  provider: ProviderName | null;
  model: string | null;
  model_profile_version?: string | null;
  provider_instruction_profile?: string | null;
  structured_output_mode?: string | null;
  provider_job_status: JobStatus | null;
  provider_error_code: string | null;
  provider_result_id: string | null;
  result_status: ProviderResultStatus | null;
  context_validation_status: ContextValidationStatus | null;
  validated_response: JsonObject | null;
  validation_errors: JsonObject[];
  provider_score_id: string | null;
  metric_type: "visibility" | "ranking" | "competitive_pressure" | null;
  scoring_version: string | null;
  score: string | null;
  score_components: JsonObject | null;
  scoring_failure_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: string | null;
  estimated_input_tokens?: number | null;
  estimated_output_tokens?: number | null;
  estimated_cost_micros?: string | null;
};

export type DiscoveryReportRecord = {
  discovery_status: string | null;
  discovery_coverage: JsonObject;
  reused_from_pre_analysis_request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: string | null;
  estimated_input_tokens?: number | null;
  estimated_output_tokens?: number | null;
  estimated_cost_micros?: string | null;
};

export type ReportMethodologyContext = {
  domain: string;
  category_selection_mode: string;
  prompt_depth: PromptDepth;
  prompt_policy_version: string;
  requested_category_ids: string[];
  selected_provider_models: JsonObject[];
  matched_categories: JsonObject[];
  request_payload?: JsonObject;
  created_at: string;
  completed_at: string | null;
};

export class ReportRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async lockRun(analysisRunId: string) {
    const result = await this.database.query<{
      analysis_run_id: string;
      status: AnalysisExecutionStatus;
      prompt_depth: PromptDepth;
      prompt_policy_version: string;
    }>(
      `
        SELECT analysis_run_id, status, prompt_depth, prompt_policy_version
        FROM analysis_runs
        WHERE analysis_run_id = $1
        FOR UPDATE
      `,
      [analysisRunId]
    );
    const row = result.rows[0];
    return row
      ? ({
          analysisRunId: row.analysis_run_id,
          status: row.status,
          promptDepth: row.prompt_depth,
          promptPolicyVersion: row.prompt_policy_version
        } satisfies ExpectedPlanRun)
      : null;
  }

  async expectedPlanItems(analysisRunId: string) {
    const result = await this.database.query<{
      analysis_run_item_id: string;
      entity_path_id: string;
      path_type: EntityPathType;
      category_id: string | null;
      category_name: string | null;
      item_ordinal: number;
      status: AnalysisExecutionStatus;
    }>(
      `
        SELECT
          item.analysis_run_item_id,
          item.entity_path_id,
          path.path_type,
          path.category_id,
          category.category_name,
          item.item_ordinal,
          item.status
        FROM analysis_run_items AS item
        JOIN entity_paths AS path
          ON path.entity_path_id = item.entity_path_id
        LEFT JOIN categories AS category
          ON category.category_id = path.category_id
        WHERE item.analysis_run_id = $1
        ORDER BY item.item_ordinal, item.analysis_run_item_id
      `,
      [analysisRunId]
    );
    return result.rows.map(
      (row) =>
        ({
          analysisRunItemId: row.analysis_run_item_id,
          entityPathId: row.entity_path_id,
          targetLevel: row.path_type,
          categoryId: row.category_id,
          categoryName: row.category_name,
          itemOrdinal: row.item_ordinal,
          status: row.status
        }) satisfies ExpectedPlanItem
    );
  }

  async expectedPlanProviderModels(analysisRunId: string) {
    const result = await this.database.query<{
      provider: ProviderName;
      model: string;
      model_profile_version: string;
      ordinal: number;
    }>(
      `
        SELECT provider, model, model_profile_version, ordinal
        FROM analysis_run_provider_models
        WHERE analysis_run_id = $1
        ORDER BY ordinal, provider, model
      `,
      [analysisRunId]
    );
    return result.rows.map(
      (row) =>
        ({
          provider: row.provider,
          model: row.model,
          modelProfileVersion: row.model_profile_version,
          ordinal: row.ordinal
        }) satisfies ExpectedPlanProviderModel
    );
  }

  async materializationRecords(
    analysisRunId: string,
    scoringVersion: string
  ) {
    const result = await this.database.query<ReportMaterializationRecord>(
      `
        SELECT
          item.analysis_run_item_id,
          item.item_ordinal,
          item.status AS item_status,
          item.entity_path_id,
          path.category_id,
          category.category_name,
          llm.llm_run_id,
          llm.status AS llm_run_status,
          llm.error_code AS llm_error_code,
          prompt.prompt_job_id,
          prompt.prompt_type,
          prompt.prompt_depth,
          prompt.business_prompt_version,
          prompt.response_contract_version,
          prompt.status AS prompt_job_status,
          prompt.error_code AS prompt_error_code,
          job.provider_job_id,
          job.provider,
          job.model,
          job.model_profile_version,
          job.provider_instruction_profile,
          job.structured_output_mode,
          job.status AS provider_job_status,
          job.error_code AS provider_error_code,
          result.provider_result_id,
          result.status AS result_status,
          result.context_validation_status,
          result.validated_response,
          COALESCE(result.validation_errors, '[]'::jsonb)
            AS validation_errors,
          score.provider_score_id,
          score.metric_type,
          score.scoring_version,
          score.score,
          score.score_components,
          scoring_failure.error_code AS scoring_failure_code,
          actual_usage.input_tokens,
          actual_usage.output_tokens,
          actual_usage.cost_micros,
          estimated_usage.input_tokens AS estimated_input_tokens,
          estimated_usage.output_tokens AS estimated_output_tokens,
          estimated_usage.cost_micros AS estimated_cost_micros
        FROM analysis_run_items AS item
        JOIN entity_paths AS path
          ON path.entity_path_id = item.entity_path_id
        LEFT JOIN categories AS category
          ON category.category_id = path.category_id
        LEFT JOIN llm_runs AS llm
          ON llm.analysis_run_item_id = item.analysis_run_item_id
        LEFT JOIN prompt_jobs AS prompt
          ON prompt.llm_run_id = llm.llm_run_id
        LEFT JOIN provider_jobs AS job
          ON job.prompt_job_id = prompt.prompt_job_id
         AND job.job_kind = 'normal_prompt'
        LEFT JOIN provider_results AS result
          ON result.provider_job_id = job.provider_job_id
        LEFT JOIN provider_scores AS score
          ON score.provider_result_id = result.provider_result_id
         AND score.scoring_version = $2
        LEFT JOIN token_usage AS actual_usage
          ON actual_usage.provider_job_id = job.provider_job_id
         AND actual_usage.usage_kind = 'actual'
        LEFT JOIN token_usage AS estimated_usage
          ON estimated_usage.provider_job_id = job.provider_job_id
         AND estimated_usage.usage_kind = 'estimated'
        LEFT JOIN LATERAL (
          SELECT failure.error_code
          FROM failure_records AS failure
          WHERE failure.aggregate_type = 'provider_result'
            AND failure.aggregate_id = result.provider_result_id::text
            AND failure.queue_name = 'scoring_queue'
            AND (
              failure.attempt_number >= 3
              OR failure.error_details @> '{"permanent":true}'::jsonb
            )
          ORDER BY
            failure.attempt_number DESC,
            failure.failure_record_id DESC
          LIMIT 1
        ) AS scoring_failure ON true
        WHERE item.analysis_run_id = $1
        ORDER BY
          item.item_ordinal,
          item.analysis_run_item_id,
          prompt.prompt_job_id NULLS FIRST,
          job.provider NULLS FIRST,
          job.model NULLS FIRST,
          job.provider_job_id NULLS FIRST
      `,
      [analysisRunId, scoringVersion]
    );
    return result.rows;
  }

  async discoveryRecord(analysisRunId: string) {
    const result = await this.database.query<DiscoveryReportRecord>(
      `
        SELECT
          request.discovery_status,
          request.discovery_coverage,
          request.reused_from_pre_analysis_request_id,
          usage.input_tokens, usage.output_tokens, usage.cost_micros,
          usage.estimated_input_tokens, usage.estimated_output_tokens,
          usage.estimated_cost_micros
        FROM analysis_runs run
        JOIN pre_analysis_requests request
          ON request.pre_analysis_request_id=run.pre_analysis_request_id
        LEFT JOIN LATERAL (
          SELECT
            sum(actual.input_tokens)::bigint AS input_tokens,
            sum(actual.output_tokens)::bigint AS output_tokens,
            sum(actual.cost_micros)::bigint AS cost_micros,
            sum(estimated.input_tokens)::bigint AS estimated_input_tokens,
            sum(estimated.output_tokens)::bigint AS estimated_output_tokens,
            sum(estimated.cost_micros)::bigint AS estimated_cost_micros
          FROM hierarchy_discovery_jobs discovery
          JOIN provider_jobs job ON job.discovery_job_id=discovery.hierarchy_discovery_job_id
          LEFT JOIN token_usage actual ON actual.provider_job_id=job.provider_job_id AND actual.usage_kind='actual'
          LEFT JOIN token_usage estimated ON estimated.provider_job_id=job.provider_job_id AND estimated.usage_kind='estimated'
          WHERE discovery.pre_analysis_request_id=request.pre_analysis_request_id
        ) usage ON true
        WHERE run.analysis_run_id=$1
      `,
      [analysisRunId]
    );
    return result.rows[0] ?? null;
  }

  async methodologyContext(analysisRunId: string) {
    const result = await this.database.query<ReportMethodologyContext>(
      `
        SELECT
          domain.normalized_domain AS domain,
          run.category_selection_mode,
          run.prompt_depth,
          run.prompt_policy_version,
          run.request_payload,
          COALESCE(
            (
              SELECT jsonb_agg(requested.category_id::text ORDER BY requested.ordinal)
              FROM analysis_run_requested_categories AS requested
              WHERE requested.analysis_run_id = run.analysis_run_id
            ),
            '[]'::jsonb
          ) AS requested_category_ids,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'provider', model.provider,
                  'model', model.model,
                  'modelProfileVersion', model.model_profile_version
                )
                ORDER BY model.ordinal
              )
              FROM analysis_run_provider_models AS model
              WHERE model.analysis_run_id = run.analysis_run_id
            ),
            '[]'::jsonb
          ) AS selected_provider_models,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'categoryId', matched.category_id,
                  'categoryName', matched.category_name,
                  'source', matched.source,
                  'providerResultId', matched.discovery_provider_result_id,
                  'discoveryRank', matched.discovery_rank,
                  'discoveryConfidence', matched.discovery_confidence,
                  'discoveredAt', matched.discovered_at,
                  'relationshipCreatedAt', matched.relationship_created_at
                )
                ORDER BY matched.item_ordinal
              )
              FROM (
                SELECT DISTINCT ON (item.item_ordinal, category.category_id)
                  item.item_ordinal,
                  category.category_id::text AS category_id,
                  category.category_name,
                  relationship.source,
                  relationship.discovery_provider_result_id,
                  relationship.discovery_rank,
                  relationship.discovery_confidence,
                  relationship.discovered_at,
                  relationship.created_at AS relationship_created_at
                FROM analysis_run_items AS item
                JOIN entity_paths AS path
                  ON path.entity_path_id = item.entity_path_id
                JOIN categories AS category
                  ON category.category_id = path.category_id
                LEFT JOIN domain_categories AS relationship
                  ON relationship.domain_id = path.domain_id
                 AND relationship.category_id = path.category_id
                WHERE item.analysis_run_id = run.analysis_run_id
                ORDER BY item.item_ordinal, category.category_id
              ) AS matched
            ),
            '[]'::jsonb
          ) AS matched_categories,
          run.created_at::text,
          run.completed_at::text
        FROM analysis_runs AS run
        JOIN entity_paths AS starting_path
          ON starting_path.entity_path_id = run.starting_entity_path_id
        JOIN domains AS domain ON domain.domain_id = starting_path.domain_id
        WHERE run.analysis_run_id = $1
      `,
      [analysisRunId]
    );
    return result.rows[0] ?? null;
  }

  async latest(analysisRunId: string, reportVersion: string) {
    const result = await this.database.query<ReportRow>(
      `
        SELECT *
        FROM reports
        WHERE analysis_run_id = $1
          AND report_version = $2
        ORDER BY revision DESC
        LIMIT 1
      `,
      [analysisRunId, reportVersion]
    );
    return result.rows[0] ?? null;
  }

  async createRevision(input: {
    analysisRunId: string;
    reportVersion: string;
    status: ReportStatus;
    reportData: JsonObject;
    renderedText: string;
  }) {
    const latest = await this.latest(input.analysisRunId, input.reportVersion);
    if (
      latest &&
      latest.status === input.status &&
      isDeepStrictEqual(latest.report_data, input.reportData) &&
      latest.rendered_text === input.renderedText
    ) {
      return { row: latest, created: false };
    }
    const revision = (latest?.revision ?? 0) + 1;
    const idempotencyKey =
      `report:${input.analysisRunId}:${input.reportVersion}:${revision}`;
    const result = await this.database.query<ReportRow>(
      `
        INSERT INTO reports (
          idempotency_key,
          analysis_run_id,
          report_version,
          revision,
          status,
          report_data,
          rendered_text
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (analysis_run_id, report_version, revision) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.analysisRunId,
        input.reportVersion,
        revision,
        input.status,
        input.reportData,
        input.renderedText
      ]
    );
    if (result.rows[0]) return { row: result.rows[0], created: true };
    const raced = await this.latest(input.analysisRunId, input.reportVersion);
    if (!raced) throw new Error("Report revision could not be loaded");
    return { row: raced, created: false };
  }

  async markRunFinal(
    analysisRunId: string,
    status: "completed" | "partial_success" | "failed" | "cancelled"
  ) {
    await this.database.query(
      `
        UPDATE analysis_runs
        SET status = $2,
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
        WHERE analysis_run_id = $1
          AND status <> 'cancelled'
      `,
      [analysisRunId, status]
    );
  }
}
