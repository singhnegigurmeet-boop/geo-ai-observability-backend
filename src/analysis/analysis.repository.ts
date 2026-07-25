import type { DatabaseExecutor } from "../db/database-executor.js";
import type { OwnershipContext } from "../ownership/ownership-context.types.js";
import type {
  AnalysisRunRow,
  AnalysisRunProviderModelRow,
  JsonObject,
  ProviderName
} from "../types/database.types.js";
import type {
  AnalysisReportRecord,
  AnalysisRunStatusRecord
} from "./analysis.types.js";

export type CreateAnalysisRunRecord = {
  idempotencyKey: string;
  anonymousSessionId: string | null;
  userId: string | null;
  workspaceId: string | null;
  startingEntityPathId: string;
  requestedProvider: ProviderName | null;
  requestedModel: string | null;
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
          requested_provider,
          requested_model,
          source,
          status,
          request_payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', 'queued', $8)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `,
      [
        input.idempotencyKey,
        input.anonymousSessionId,
        input.userId,
        input.workspaceId,
        input.startingEntityPathId,
        input.requestedProvider,
        input.requestedModel,
        input.requestPayload
      ]
    );
    return result.rows[0] ?? null;
  }

  async createProviderModels(
    analysisRunId: string,
    providerModels: Array<{ provider: ProviderName; model: string }>
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
    return this.findProviderModels(analysisRunId);
  }

  async findProviderModels(analysisRunId: string) {
    const result = await this.database.query<AnalysisRunProviderModelRow>(
      `
        SELECT *
        FROM analysis_run_provider_models
        WHERE analysis_run_id = $1
        ORDER BY ordinal, provider, model
      `,
      [analysisRunId]
    );
    return result.rows;
  }

  async findOwnedStatus(analysisRunId: string, owner: OwnershipContext) {
    const ownership = ownedRunClause(analysisRunId, owner);

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
    const ownership = ownedRunClause(analysisRunId, owner);
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
    const ownership = ownedRunClause(analysisRunId, owner);
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

function ownedRunClause(
  analysisRunId: string,
  owner: OwnershipContext
) {
  return owner.actorType === "anonymous"
    ? {
        clause: `
          run.anonymous_session_id = $2
          AND run.user_id IS NULL
          AND run.workspace_id IS NULL
        `,
        values: [analysisRunId, owner.anonymousSessionId]
      }
      : {
        clause: `
          (
            (run.user_id = $2 AND run.workspace_id = $3)
            OR (
              run.user_id IS NULL
              AND run.workspace_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM anonymous_sessions AS claimed_session
                WHERE claimed_session.anonymous_session_id =
                      run.anonymous_session_id
                  AND claimed_session.claimed_by_user_id = $2
                  AND claimed_session.claimed_workspace_id = $3
                  AND claimed_session.claimed_at IS NOT NULL
              )
            )
          )
        `,
        values: [analysisRunId, owner.userId, owner.workspaceId]
      };
}
