import type { DatabaseExecutor } from "../db/database-executor.js";
import { isDeepStrictEqual } from "node:util";
import type {
  JobStatus,
  JsonObject,
  PromptType,
  ProviderName,
  ProviderResultStatus,
  ReportRow,
  ReportStatus
} from "../types/database.types.js";

export type ReportExecutionRecord = {
  prompt_job_id: string;
  prompt_type: PromptType;
  prompt_version: string;
  provider_job_id: string;
  provider: ProviderName;
  model: string;
  provider_job_status: JobStatus;
  error_code: string | null;
  result_status: ProviderResultStatus | null;
  parsed_response: JsonObject | null;
  scoring_version: string | null;
  score: string | null;
  score_components: JsonObject | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: string | null;
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
          prompt.prompt_version,
          job.provider_job_id,
          job.provider,
          job.model,
          job.status AS provider_job_status,
          job.error_code,
          result.status AS result_status,
          result.parsed_response,
          score.scoring_version,
          score.score,
          score.score_components,
          usage.input_tokens,
          usage.output_tokens,
          usage.cost_micros
        FROM analysis_run_items AS item
        JOIN llm_runs AS llm
          ON llm.analysis_run_item_id = item.analysis_run_item_id
        JOIN prompt_jobs AS prompt ON prompt.llm_run_id = llm.llm_run_id
        JOIN provider_jobs AS job ON job.prompt_job_id = prompt.prompt_job_id
        LEFT JOIN provider_results AS result
          ON result.provider_job_id = job.provider_job_id
        LEFT JOIN provider_scores AS score
          ON score.provider_result_id = result.provider_result_id
         AND score.scoring_version = $2
        LEFT JOIN token_usage AS usage
          ON usage.provider_job_id = job.provider_job_id
         AND usage.usage_kind = 'actual'
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
