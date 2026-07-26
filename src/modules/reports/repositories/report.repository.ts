import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import { isDeepStrictEqual } from "node:util";
import type {
  JobStatus,
  JsonObject,
  PromptDepth,
  PromptType,
  ProviderName,
  ProviderResultStatus,
  ReportRow,
  ReportStatus
} from "../../../common/types/database.types.js";

export type ReportExecutionRecord = {
  prompt_job_id: string;
  prompt_type: PromptType;
  prompt_depth: PromptDepth;
  business_prompt_version: string;
  response_contract_version: string;
  entity_path_id: string;
  category_id: string | null;
  category_name: string | null;
  provider_job_id: string;
  provider: ProviderName;
  model: string;
  provider_job_status: JobStatus;
  error_code: string | null;
  result_status: ProviderResultStatus | null;
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
};

export type ClassificationReportRecord = {
  classification_status: string;
  classifier_provider: ProviderName;
  classifier_model: string;
  model_profile_version: string;
  prompt_version: string;
  response_contract_version: string;
  provider_result_id: string | null;
  result_status: ProviderResultStatus | null;
  validated_response: JsonObject | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: string | null;
};

export type ReportMethodologyContext = {
  domain: string;
  category_selection_mode: string;
  prompt_depth: PromptDepth;
  prompt_policy_version: string;
  requested_category_ids: string[];
  selected_provider_models: JsonObject[];
  matched_categories: JsonObject[];
  created_at: string;
  completed_at: string | null;
};

export class ReportRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async lockRun(analysisRunId: string) {
    const result = await this.database.query<{ status: string }>(
      `
        SELECT status
        FROM analysis_runs
        WHERE analysis_run_id = $1
        FOR UPDATE
      `,
      [analysisRunId]
    );
    return result.rows[0] ?? null;
  }

  async executionRecords(analysisRunId: string, scoringVersion: string) {
    const result = await this.database.query<ReportExecutionRecord>(
      `
        SELECT
          prompt.prompt_job_id,
          prompt.prompt_type,
          prompt.prompt_depth,
          prompt.business_prompt_version,
          prompt.response_contract_version,
          item.entity_path_id,
          path.category_id,
          category.category_name,
          job.provider_job_id,
          job.provider,
          job.model,
          job.status AS provider_job_status,
          job.error_code,
          result.status AS result_status,
          result.validated_response,
          result.validation_errors,
          score.metric_type,
          score.scoring_version,
          score.score,
          score.score_components,
          scoring_failure.error_code AS scoring_failure_code,
          usage.input_tokens,
          usage.output_tokens,
          usage.cost_micros
        FROM analysis_run_items AS item
        JOIN llm_runs AS llm
          ON llm.analysis_run_item_id = item.analysis_run_item_id
        JOIN prompt_jobs AS prompt ON prompt.llm_run_id = llm.llm_run_id
        JOIN entity_paths AS path ON path.entity_path_id = item.entity_path_id
        LEFT JOIN categories AS category
          ON category.category_id = path.category_id
        JOIN provider_jobs AS job ON job.prompt_job_id = prompt.prompt_job_id
        LEFT JOIN provider_results AS result
          ON result.provider_job_id = job.provider_job_id
        LEFT JOIN provider_scores AS score
          ON score.provider_result_id = result.provider_result_id
         AND score.scoring_version = $2
        LEFT JOIN token_usage AS usage
          ON usage.provider_job_id = job.provider_job_id
         AND usage.usage_kind = 'actual'
        LEFT JOIN LATERAL (
          SELECT failure.error_code
          FROM failure_records AS failure
          WHERE failure.aggregate_type = 'provider_result'
            AND failure.aggregate_id = result.provider_result_id::text
            AND (
              failure.attempt_number >= 3
              OR failure.error_details @> '{"permanent":true}'::jsonb
            )
          ORDER BY failure.attempt_number DESC, failure.failure_record_id DESC
          LIMIT 1
        ) AS scoring_failure ON true
        WHERE item.analysis_run_id = $1
        ORDER BY
          prompt.prompt_job_id,
          job.provider,
          job.model,
          job.provider_job_id
      `,
      [analysisRunId, scoringVersion]
    );
    return result.rows;
  }

  async expectedProviderExecutionCount(analysisRunId: string) {
    const result = await this.database.query<{ expected_count: string }>(
      `
        SELECT COALESCE(
          SUM(
            CASE
              WHEN path.path_type = 'domain' THEN 0
              WHEN path.path_type = 'category' THEN 3
              ELSE 5
            END * model_count.count
          ),
          0
        )::bigint AS expected_count
        FROM analysis_run_items AS item
        JOIN entity_paths AS path ON path.entity_path_id = item.entity_path_id
        CROSS JOIN LATERAL (
          SELECT count(*)::integer AS count
          FROM analysis_run_provider_models AS model
          WHERE model.analysis_run_id = item.analysis_run_id
        ) AS model_count
        WHERE item.analysis_run_id = $1
      `,
      [analysisRunId]
    );
    return Number(result.rows[0]?.expected_count ?? 0);
  }

  async classificationRecord(analysisRunId: string) {
    const result = await this.database.query<ClassificationReportRecord>(
      `
        SELECT
          classification.status AS classification_status,
          classification.classifier_provider,
          classification.classifier_model,
          classification.model_profile_version,
          classification.prompt_version,
          classification.response_contract_version,
          result.provider_result_id,
          result.status AS result_status,
          result.validated_response,
          usage.input_tokens,
          usage.output_tokens,
          usage.cost_micros
        FROM domain_category_classification_jobs AS classification
        LEFT JOIN provider_jobs AS job
          ON job.classification_job_id =
             classification.domain_category_classification_job_id
        LEFT JOIN provider_results AS result
          ON result.provider_job_id = job.provider_job_id
        LEFT JOIN token_usage AS usage
          ON usage.provider_job_id = job.provider_job_id
         AND usage.usage_kind = 'actual'
        WHERE classification.analysis_run_id = $1
        ORDER BY classification.created_at DESC
        LIMIT 1
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
                  'classificationRank', matched.classification_rank,
                  'classificationConfidence', matched.classification_confidence
                )
                ORDER BY matched.item_ordinal
              )
              FROM (
                SELECT DISTINCT ON (item.item_ordinal, category.category_id)
                  item.item_ordinal,
                  category.category_id::text AS category_id,
                  category.category_name,
                  relationship.source,
                  relationship.classification_rank,
                  relationship.classification_confidence
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
