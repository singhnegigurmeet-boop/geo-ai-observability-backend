import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  WorkspaceMemberRow,
  WorkspaceRole
} from "../../../common/types/database.types.js";

export class WorkspaceMemberRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async add(userId: string, workspaceId: string, role: WorkspaceRole) {
    const result = await this.database.query<WorkspaceMemberRow>(
      `
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [workspaceId, userId, role]
    );
    return result.rows[0] as WorkspaceMemberRow;
  }

  async findActiveMembership(userId: string, workspaceId: string) {
    const result = await this.database.query<WorkspaceMemberRow>(
      `
        SELECT member.*
        FROM workspace_members AS member
        JOIN workspaces
          ON workspaces.workspace_id = member.workspace_id
         AND workspaces.deleted_at IS NULL
        JOIN users
          ON users.user_id = member.user_id
         AND users.status = 'active'
         AND users.deleted_at IS NULL
        WHERE member.user_id = $1
          AND member.workspace_id = $2
      `,
      [userId, workspaceId]
    );
    return result.rows[0] ?? null;
  }

  async listActiveForUser(userId: string) {
    const result = await this.database.query<WorkspaceMemberRow>(
      `
        SELECT member.*
        FROM workspace_members AS member
        JOIN workspaces
          ON workspaces.workspace_id = member.workspace_id
         AND workspaces.deleted_at IS NULL
        WHERE member.user_id = $1
        ORDER BY member.joined_at ASC, member.workspace_id ASC
      `,
      [userId]
    );
    return result.rows;
  }
}
