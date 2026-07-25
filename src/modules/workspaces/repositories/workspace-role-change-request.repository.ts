import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  WorkspaceRole,
  WorkspaceRoleChangeRequestRow
} from "../../../common/types/database.types.js";

export type CreateRoleChangeRequest = {
  workspaceId: string;
  targetUserId: string;
  requestedRole: WorkspaceRole;
  requestedByUserId: string;
  requestReason: string | null;
};

export class WorkspaceRoleChangeRequestRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async create(input: CreateRoleChangeRequest) {
    const result = await this.database.query<WorkspaceRoleChangeRequestRow>(
      `
        INSERT INTO workspace_role_change_requests (
          workspace_id,
          target_user_id,
          requested_role,
          requested_by_user_id,
          request_reason
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
      [
        input.workspaceId,
        input.targetUserId,
        input.requestedRole,
        input.requestedByUserId,
        input.requestReason
      ]
    );
    return result.rows[0] as WorkspaceRoleChangeRequestRow;
  }

  async findPending(workspaceId: string) {
    const result = await this.database.query<WorkspaceRoleChangeRequestRow>(
      `
        SELECT *
        FROM workspace_role_change_requests
        WHERE workspace_id = $1
          AND status = 'pending'
        ORDER BY created_at ASC
      `,
      [workspaceId]
    );
    return result.rows;
  }

  async review(
    requestId: string,
    reviewerUserId: string,
    status: "approved" | "rejected",
    reviewNote: string | null,
    reviewedAt: Date
  ) {
    const result = await this.database.query<WorkspaceRoleChangeRequestRow>(
      `
        UPDATE workspace_role_change_requests
        SET status = $3,
            reviewed_by_user_id = $2,
            review_note = $4,
            reviewed_at = $5,
            updated_at = $5
        WHERE workspace_role_change_request_id = $1
          AND status = 'pending'
        RETURNING *
      `,
      [requestId, reviewerUserId, status, reviewNote, reviewedAt]
    );
    return result.rows[0] ?? null;
  }
}
