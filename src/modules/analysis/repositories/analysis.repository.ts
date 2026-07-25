import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import { ownedAnalysisRunClause } from "../../../common/ownership/owned-analysis-run.sql.js";
import type { OwnershipContext } from "../../../common/ownership/ownership-context.types.js";
import type { AnalysisRunRow, JsonObject } from "../../../common/types/database.types.js";
import type {
  AnalysisReportRecord,
  AnalysisRunStatusRecord
} from "../types/analysis.types.js";

export type CreateAnalysisRunRecord = {
  idempotencyKey: string;
  anonymousSessionId: string | null;
  userId: string | null;
  workspaceId: string | null;
  startingEntityPathId: string;
  requestPayload: JsonObject;
};

export class AnalysisRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findByIdempotencyKey(idempotencyKey: string) {
    const result = await this.database.query<AnalysisRunRow>(
      "SELECT * FROM analysis_runs WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    return result.rows[0] ?? null;
  }

  async create(input: CreateAnalysisRunRecord) {
    const result = await this.database.query<AnalysisRunRow>(
      `
        INSERT INTO analysis_runs (
          idempotency_key,
          anonymous_session_id,
          user_id,
          workspace_id,
          starting_entity_path_id,
          source,
          status,
          request_payload
        )
        VALUES ($1, $2, $3, $4, $5, 'manual', 'queued', $6)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `,
      [
        input.idempotencyKey,
        input.anonymousSessionId,
        input.userId,
        input.workspaceId,
        input.startingEntityPathId,
        input.requestPayload
      ]
    );
    return result.rows[0] ?? null;
  }

  async findOwnedStatus(analysisRunId: string, owner: OwnershipContext) {
    const ownership = ownedAnalysisRunClause(analysisRunId, owner);

    const result = await this.database.query<AnalysisRunStatusRecord>(
      `
        SELECT
          run.analysis_run_id,
          run.status,
          run.source,
          run.error_code,
          run.error_message,
          run.started_at,
          run.completed_at,
          run.created_at,
          run.updated_at,
          path.entity_path_id,
          path.path_type,
          path.domain_id,
          domain.normalized_domain,
          path.category_id,
          path.brand_id,
          path.product_id,
          path.use_context_id
        FROM analysis_runs AS run
        JOIN entity_paths AS path
          ON path.entity_path_id = run.starting_entity_path_id
        JOIN domains AS domain
          ON domain.domain_id = path.domain_id
        WHERE run.analysis_run_id = $1
          AND ${ownership.clause}
      `,
      ownership.values
    );
    return result.rows[0] ?? null;
  }

  async findOwnedRunForUpdate(
    analysisRunId: string,
    owner: OwnershipContext
  ) {
    const ownership = ownedAnalysisRunClause(analysisRunId, owner);
    const result = await this.database.query<AnalysisRunRow>(
      `
        SELECT run.*
        FROM analysis_runs AS run
        WHERE run.analysis_run_id = $1
          AND ${ownership.clause}
        FOR UPDATE OF run
      `,
      ownership.values
    );
    return result.rows[0] ?? null;
  }

  async findOwnedReport(analysisRunId: string, owner: OwnershipContext) {
    const ownership = ownedAnalysisRunClause(analysisRunId, owner);
    const result = await this.database.query<AnalysisReportRecord>(
      `
        SELECT
          run.analysis_run_id,
          report.report_id,
          report.report_version,
          report.revision,
          report.status,
          report.report_data,
          report.rendered_text,
          report.generated_at
        FROM analysis_runs AS run
        JOIN LATERAL (
          SELECT candidate.*
          FROM reports AS candidate
          WHERE candidate.analysis_run_id = run.analysis_run_id
          ORDER BY
            (candidate.report_version = 'multi-provider-v2') DESC,
            candidate.revision DESC,
            candidate.report_id DESC
          LIMIT 1
        ) AS report ON true
        WHERE run.analysis_run_id = $1
          AND ${ownership.clause}
      `,
      ownership.values
    );
    return result.rows[0] ?? null;
  }
}
