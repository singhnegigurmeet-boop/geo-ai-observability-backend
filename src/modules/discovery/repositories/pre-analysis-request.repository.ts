import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type { JsonObject, PreAnalysisRequestRow, PromptDepth } from "../../../common/types/database.types.js";
import type { OwnershipContext } from "../../../common/ownership/ownership-context.types.js";

export class PreAnalysisRequestRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async create(input: { idempotencyKey: string; owner: OwnershipContext; domainId: string; startingEntityPathId: string; categorySelectionMode: "all" | "selected"; promptDepth: PromptDepth; source: "manual" | "scheduled"; requestPayload: JsonObject; canonicalRequestHash: string; discoveryCompatibilityHash: string }) {
    const ownership = input.owner.actorType === "anonymous"
      ? [input.owner.anonymousSessionId, null, null]
      : [input.owner.anonymousSessionId, input.owner.userId, input.owner.workspaceId];
    const result = await this.database.query<PreAnalysisRequestRow>(
      `INSERT INTO pre_analysis_requests
         (idempotency_key, anonymous_session_id, user_id, workspace_id,
          domain_id, starting_entity_path_id, category_selection_mode,
          prompt_depth, source, status, request_payload,
          canonical_request_hash, discovery_compatibility_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted',$10,$11,$12)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [input.idempotencyKey, ...ownership, input.domainId, input.startingEntityPathId,
       input.categorySelectionMode, input.promptDepth, input.source,
       input.requestPayload, input.canonicalRequestHash, input.discoveryCompatibilityHash]
    );
    return result.rows[0] ?? null;
  }

  async findByIdempotencyKey(key: string) {
    const result = await this.database.query<PreAnalysisRequestRow>("SELECT * FROM pre_analysis_requests WHERE idempotency_key=$1", [key]);
    return result.rows[0] ?? null;
  }

  async findForUpdate(id: string) {
    const result = await this.database.query<PreAnalysisRequestRow>("SELECT * FROM pre_analysis_requests WHERE pre_analysis_request_id=$1 FOR UPDATE", [id]);
    return result.rows[0] ?? null;
  }

  async findOwned(id: string, owner: OwnershipContext) {
    const values = owner.actorType === "anonymous"
      ? [id, owner.anonymousSessionId]
      : [id, owner.userId, owner.workspaceId];
    const sql = owner.actorType === "anonymous"
      ? "SELECT * FROM pre_analysis_requests WHERE pre_analysis_request_id=$1 AND anonymous_session_id=$2 AND user_id IS NULL"
      : `SELECT request.* FROM pre_analysis_requests request
         LEFT JOIN anonymous_sessions session ON session.anonymous_session_id=request.anonymous_session_id
         WHERE request.pre_analysis_request_id=$1 AND ((request.user_id=$2 AND request.workspace_id=$3) OR (request.user_id IS NULL AND session.claimed_by_user_id=$2 AND session.claimed_workspace_id=$3))`;
    const result = await this.database.query<PreAnalysisRequestRow>(sql, values);
    return result.rows[0] ?? null;
  }

  async findReusable(request: PreAnalysisRequestRow) {
    const authenticated = request.user_id !== null && request.workspace_id !== null;
    const result = await this.database.query<PreAnalysisRequestRow>(
      `SELECT * FROM pre_analysis_requests
       WHERE domain_id=$1 AND discovery_compatibility_hash=$2
          AND pre_analysis_request_id<>$3
          AND status='analysis_created' AND discovery_status IN ('completed','partial_success')
          AND (
            ($4::boolean AND user_id IS NOT NULL AND workspace_id=$5)
            OR
            (NOT $4::boolean AND user_id IS NULL AND workspace_id IS NULL
             AND anonymous_session_id=$6)
          )
       ORDER BY completed_at DESC, pre_analysis_request_id DESC LIMIT 1`,
      [request.domain_id, request.discovery_compatibility_hash,
       request.pre_analysis_request_id, authenticated, request.workspace_id,
       request.anonymous_session_id]
    );
    return result.rows[0] ?? null;
  }

  async findReusableNavigation(input: {
    owner: OwnershipContext;
    domainId: string;
    discoveryCompatibilityHash: string;
  }) {
    const authenticated = input.owner.actorType === "user";
    const result = await this.database.query<PreAnalysisRequestRow>(
      `SELECT * FROM pre_analysis_requests
       WHERE domain_id=$1 AND discovery_compatibility_hash=$2
         AND request_payload->>'operation'='navigate'
         AND status='completed_without_analysis'
         AND discovery_status IN ('completed','completed_empty','partial_success')
         AND (
           ($3::boolean AND user_id IS NOT NULL AND workspace_id=$4)
           OR
           (NOT $3::boolean AND user_id IS NULL AND workspace_id IS NULL AND anonymous_session_id=$5)
         )
       ORDER BY completed_at DESC,pre_analysis_request_id DESC LIMIT 1`,
      [
        input.domainId,
        input.discoveryCompatibilityHash,
        authenticated,
        input.owner.actorType === "user" ? input.owner.workspaceId : null,
        input.owner.anonymousSessionId
      ]
    );
    return result.rows[0] ?? null;
  }

  async hasCompletedCompatibleExecution(request: PreAnalysisRequestRow) {
    const result = await this.database.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pre_analysis_requests prior
         WHERE prior.domain_id=$1 AND prior.discovery_compatibility_hash=$2
           AND prior.pre_analysis_request_id<>$3
           AND prior.status='analysis_created'
           AND prior.discovery_status IN ('completed','partial_success')
           AND EXISTS (
             SELECT 1 FROM hierarchy_discovery_jobs discovery
             WHERE discovery.pre_analysis_request_id=prior.pre_analysis_request_id
           )
       ) AS exists`,
      [request.domain_id, request.discovery_compatibility_hash,
       request.pre_analysis_request_id]
    );
    return result.rows[0]?.exists ?? false;
  }

  async mark(id: string, input: { status: PreAnalysisRequestRow["status"]; discoveryStatus?: string | null; coverage?: JsonObject; errorCode?: string | null; errorMessage?: string | null; analysisRunId?: string | null; reusedFrom?: string | null }) {
    await this.database.query(
      `UPDATE pre_analysis_requests SET status=$2::pre_analysis_request_status,
         discovery_status=COALESCE($3,discovery_status),
         discovery_coverage=COALESCE($4::jsonb,discovery_coverage),
         error_code=$5, error_message=$6,
         analysis_run_id=COALESCE($7,analysis_run_id),
         reused_from_pre_analysis_request_id=COALESCE($8,reused_from_pre_analysis_request_id),
         started_at=COALESCE(started_at,now()),
         completed_at=CASE WHEN $2::pre_analysis_request_status IN ('analysis_created','completed_without_analysis','failed','cancelled') THEN now() ELSE NULL END,
         updated_at=now() WHERE pre_analysis_request_id=$1`,
      [id, input.status, input.discoveryStatus ?? null, input.coverage ?? null,
       input.errorCode ?? null, input.errorMessage ?? null,
       input.analysisRunId ?? null, input.reusedFrom ?? null]
    );
  }
}
