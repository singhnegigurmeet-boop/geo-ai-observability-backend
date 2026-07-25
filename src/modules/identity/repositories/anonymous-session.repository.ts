import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  AnonymousSessionRow,
  JsonObject
} from "../../../common/types/database.types.js";

export type CreateAnonymousSessionRecord = {
  tokenHash: string;
  expiresAt: Date;
  clientMetadata: JsonObject;
};

export class AnonymousSessionRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async create(input: CreateAnonymousSessionRecord) {
    const result = await this.database.query<AnonymousSessionRow>(
      `
        INSERT INTO anonymous_sessions (
          token_hash,
          expires_at,
          client_metadata
        )
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [input.tokenHash, input.expiresAt, input.clientMetadata]
    );
    return result.rows[0] as AnonymousSessionRow;
  }

  async findByTokenHash(tokenHash: string) {
    const result = await this.database.query<AnonymousSessionRow>(
      "SELECT * FROM anonymous_sessions WHERE token_hash = $1",
      [tokenHash]
    );
    return result.rows[0] ?? null;
  }

  async findByIdForUpdate(anonymousSessionId: string) {
    const result = await this.database.query<AnonymousSessionRow>(
      `
        SELECT *
        FROM anonymous_sessions
        WHERE anonymous_session_id = $1
        FOR UPDATE
      `,
      [anonymousSessionId]
    );
    return result.rows[0] ?? null;
  }

  async claim(
    anonymousSessionId: string,
    userId: string,
    workspaceId: string,
    claimedAt: Date
  ) {
    const result = await this.database.query<AnonymousSessionRow>(
      `
        UPDATE anonymous_sessions
        SET claimed_by_user_id = $2,
            claimed_workspace_id = $3,
            claimed_at = $4,
            updated_at = $4
        WHERE anonymous_session_id = $1
          AND claimed_by_user_id IS NULL
          AND claimed_workspace_id IS NULL
          AND claimed_at IS NULL
        RETURNING *
      `,
      [anonymousSessionId, userId, workspaceId, claimedAt]
    );
    return result.rows[0] ?? null;
  }

  async touchLastSeen(anonymousSessionId: string, seenAt: Date) {
    await this.database.query(
      `
        UPDATE anonymous_sessions
        SET last_seen_at = $2,
            updated_at = $2
        WHERE anonymous_session_id = $1
      `,
      [anonymousSessionId, seenAt]
    );
  }
}
