import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type { WorkspaceRow } from "../../../common/types/database.types.js";

export class WorkspaceRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async create(
    workspaceName: string,
    createdByUserId: string
  ) {
    const result = await this.database.query<WorkspaceRow>(
      `
        INSERT INTO workspaces (workspace_name, created_by_user_id)
        VALUES ($1, $2)
        RETURNING *
      `,
      [workspaceName, createdByUserId]
    );
    return result.rows[0] as WorkspaceRow;
  }

  async findActiveById(workspaceId: string) {
    const result = await this.database.query<WorkspaceRow>(
      `
        SELECT *
        FROM workspaces
        WHERE workspace_id = $1
          AND deleted_at IS NULL
      `,
      [workspaceId]
    );
    return result.rows[0] ?? null;
  }
}
