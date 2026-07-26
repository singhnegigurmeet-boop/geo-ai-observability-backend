import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  AnalysisExecutionStatus,
  JsonObject,
  PromptType,
  ProviderScoreMetricType,
  ProviderName,
  ProviderScoreRow,
  ProviderResultStatus
} from "../../../common/types/database.types.js";

export type ProviderResultScoringState = {
  provider_result_id: string;
  provider_job_id: string;
  prompt_job_id: string;
  analysis_run_id: string;
  result_status: ProviderResultStatus;
  validated_response: JsonObject | null;
  provider: ProviderName;
  model: string;
  provider_job_status: string;
  prompt_job_status: string;
  prompt_type: PromptType;
};

export class ProviderScoreRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findForUpdate(providerResultId: string) {
    const result = await this.database.query<ProviderResultScoringState>(
      `
        SELECT
          result.provider_result_id,
          result.provider_job_id,
          prompt.prompt_job_id,
          item.analysis_run_id,
          result.status AS result_status,
          result.validated_response,
          job.provider,
          job.model,
          job.status AS provider_job_status,
          prompt.status AS prompt_job_status,
          prompt.prompt_type,
          prompt.response_contract_version
        FROM provider_results AS result
        JOIN provider_jobs AS job
          ON job.provider_job_id = result.provider_job_id
        JOIN prompt_jobs AS prompt
          ON prompt.prompt_job_id = job.prompt_job_id
        JOIN llm_runs AS llm
          ON llm.llm_run_id = prompt.llm_run_id
        JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        WHERE result.provider_result_id = $1
        FOR UPDATE OF result
      `,
      [providerResultId]
    );
    return result.rows[0] ?? null;
  }

  async createOrReuse(input: {
    providerResultId: string;
    score: number;
    components: JsonObject;
    scoringVersion: string;
    metricType: ProviderScoreMetricType;
  }) {
    const idempotencyKey =
      `provider_score:${input.providerResultId}:${input.scoringVersion}:${input.metricType}`;
    const inserted = await this.database.query<ProviderScoreRow>(
      `
        INSERT INTO provider_scores (
          idempotency_key,
          provider_result_id,
          metric_type,
          scoring_version,
          score,
          score_components
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (provider_result_id, scoring_version, metric_type) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.providerResultId,
        input.metricType,
        input.scoringVersion,
        input.score,
        input.components
      ]
    );
    if (inserted.rows[0]) {
      return { row: inserted.rows[0], created: true };
    }

    const existing = await this.database.query<ProviderScoreRow>(
      `
        SELECT *
        FROM provider_scores
        WHERE provider_result_id = $1
          AND scoring_version = $2
          AND metric_type = $3
          AND idempotency_key = $4
          AND score = $5
          AND score_components = $6::jsonb
      `,
      [
        input.providerResultId,
        input.scoringVersion,
        input.metricType,
        idempotencyKey,
        input.score,
        input.components
      ]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing provider score violates deterministic scoring");
    }
    return { row: existing.rows[0], created: false };
  }

  async lockAnalysisRun(analysisRunId: string) {
    const result = await this.database.query<{
      analysis_run_id: string;
      status: AnalysisExecutionStatus;
    }>(
      `
        SELECT analysis_run_id, status
        FROM analysis_runs
        WHERE analysis_run_id = $1
        FOR UPDATE
      `,
      [analysisRunId]
    );
    return result.rows[0] ?? null;
  }
}
