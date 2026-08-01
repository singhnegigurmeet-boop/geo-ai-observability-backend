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

  async findReusable(domainId: string, compatibilityHash: string, excludingId: string) {
    const result = await this.database.query<PreAnalysisRequestRow>(
      `SELECT * FROM pre_analysis_requests
       WHERE domain_id=$1 AND discovery_compatibility_hash=$2
         AND pre_analysis_request_id<>$3
         AND status='analysis_created' AND discovery_status IN ('completed','partial_success')
       ORDER BY completed_at DESC, pre_analysis_request_id DESC LIMIT 1`,
      [domainId, compatibilityHash, excludingId]
    );
    return result.rows[0] ?? null;
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
