import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  JsonObject,
  ReportRow
} from "../types/database.types.js";
import type { ReportScoreRecord } from "../scoring/score.types.js";

export type ReportReadiness = {
  prompt_count: string;
  scored_prompt_count: string;
};

export class ReportRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async readiness(analysisRunId: string, scoringVersion: string) {
    const result = await this.database.query<ReportReadiness>(
      `
        SELECT
          count(*)::text AS prompt_count,
          count(*) FILTER (
            WHERE EXISTS (
              SELECT 1
              FROM provider_jobs AS provider_job
              JOIN provider_results AS provider_result
                ON provider_result.provider_job_id = provider_job.provider_job_id
               AND provider_result.status = 'valid'
              JOIN provider_scores AS provider_score
                ON provider_score.provider_result_id =
                   provider_result.provider_result_id
               AND provider_score.scoring_version = $2
              WHERE provider_job.prompt_job_id = prompt.prompt_job_id
                AND provider_job.status = 'succeeded'
            )
          )::text AS scored_prompt_count
        FROM prompt_jobs AS prompt
        JOIN llm_runs AS llm
          ON llm.llm_run_id = prompt.llm_run_id
        JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        WHERE item.analysis_run_id = $1
      `,
      [analysisRunId, scoringVersion]
    );
    return result.rows[0] as ReportReadiness;
  }

  async scoreRecords(
    analysisRunId: string,
    scoringVersion: string
  ) {
    const result = await this.database.query<ReportScoreRecord>(
      `
        SELECT
          prompt.prompt_type,
          score.score,
          score.score_components,
          provider_job.provider,
          provider_job.model,
          provider_result.parsed_response,
          usage.input_tokens,
          usage.output_tokens,
          usage.cost_micros
        FROM analysis_run_items AS item
        JOIN llm_runs AS llm
          ON llm.analysis_run_item_id = item.analysis_run_item_id
        JOIN prompt_jobs AS prompt
          ON prompt.llm_run_id = llm.llm_run_id
        JOIN provider_jobs AS provider_job
          ON provider_job.prompt_job_id = prompt.prompt_job_id
         AND provider_job.status = 'succeeded'
        JOIN provider_results AS provider_result
          ON provider_result.provider_job_id = provider_job.provider_job_id
         AND provider_result.status = 'valid'
        JOIN provider_scores AS score
          ON score.provider_result_id = provider_result.provider_result_id
         AND score.scoring_version = $2
        LEFT JOIN token_usage AS usage
          ON usage.provider_job_id = provider_job.provider_job_id
         AND usage.usage_kind = 'actual'
        WHERE item.analysis_run_id = $1
        ORDER BY prompt.prompt_type, prompt.prompt_job_id
      `,
      [analysisRunId, scoringVersion]
    );
    return result.rows;
  }

  async createOrReuse(input: {
    analysisRunId: string;
    reportVersion: string;
    reportData: JsonObject;
    renderedText: string;
  }) {
    const idempotencyKey =
      `report:${input.analysisRunId}:${input.reportVersion}`;
    const inserted = await this.database.query<ReportRow>(
      `
        INSERT INTO reports (
          idempotency_key,
          analysis_run_id,
          report_version,
          status,
          report_data,
          rendered_text
        )
        VALUES ($1, $2, $3, 'completed', $4, $5)
        ON CONFLICT (analysis_run_id, report_version) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.analysisRunId,
        input.reportVersion,
        input.reportData,
        input.renderedText
      ]
    );
    if (inserted.rows[0]) {
      return { row: inserted.rows[0], created: true };
    }

    const existing = await this.database.query<ReportRow>(
      `
        SELECT *
        FROM reports
        WHERE analysis_run_id = $1
          AND report_version = $2
          AND idempotency_key = $3
          AND status = 'completed'
          AND report_data = $4::jsonb
          AND rendered_text = $5
      `,
      [
        input.analysisRunId,
        input.reportVersion,
        idempotencyKey,
        input.reportData,
        input.renderedText
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing report violates deterministic aggregation");
    }
    return { row: existing.rows[0], created: false };
  }

  async markRunCompleted(analysisRunId: string) {
    await this.database.query(
      `
        UPDATE llm_runs AS llm
        SET status = 'completed',
            completed_at = COALESCE(llm.completed_at, now()),
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        FROM analysis_run_items AS item
        WHERE llm.analysis_run_item_id = item.analysis_run_item_id
          AND item.analysis_run_id = $1
          AND llm.status = 'processing'
      `,
      [analysisRunId]
    );
    await this.database.query(
      `
        UPDATE analysis_run_items
        SET status = 'completed',
            completed_at = COALESCE(completed_at, now()),
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE analysis_run_id = $1
          AND status = 'processing'
      `,
      [analysisRunId]
    );
    const result = await this.database.query<{ analysis_run_id: string }>(
      `
        UPDATE analysis_runs
        SET status = 'completed',
            completed_at = COALESCE(completed_at, now()),
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE analysis_run_id = $1
          AND status = 'processing'
        RETURNING analysis_run_id
      `,
      [analysisRunId]
    );
    return Boolean(result.rows[0]);
  }
}
