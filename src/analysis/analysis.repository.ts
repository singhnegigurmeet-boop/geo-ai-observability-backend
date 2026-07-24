import type { DatabaseExecutor } from "../db/database-executor.js";
import type { OwnershipContext } from "../ownership/ownership-context.types.js";
import type {
  AnalysisRunRow,
  JsonObject
} from "../types/database.types.js";
import type { AnalysisRunStatusRecord } from "./analysis.types.js";

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
    const ownership =
      owner.actorType === "anonymous"
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
              run.user_id = $2
              AND run.workspace_id = $3
            `,
            values: [analysisRunId, owner.userId, owner.workspaceId]
          };

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
}
