import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  JsonObject,
  UserSessionRow,
  UserStatus
} from "../types/database.types.js";
import type { UserSessionIdentity } from "./identity.types.js";

type UserSessionLookupRow = UserSessionRow & {
  user_email: string;
  user_password_hash: string | null;
  user_display_name: string | null;
  user_status: UserStatus;
  user_created_at: Date;
  user_updated_at: Date;
  user_deleted_at: Date | null;
};

export type CreateUserSessionRecord = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  clientMetadata: JsonObject;
};

export class UserSessionRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async create(input: CreateUserSessionRecord) {
    const result = await this.database.query<UserSessionRow>(
      `
        INSERT INTO user_sessions (
          user_id,
          token_hash,
          expires_at,
          client_metadata
        )
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [
        input.userId,
        input.tokenHash,
        input.expiresAt,
        input.clientMetadata
      ]
    );
    return result.rows[0] as UserSessionRow;
  }

  async findIdentityByTokenHash(
    tokenHash: string
  ): Promise<UserSessionIdentity | null> {
    const result = await this.database.query<UserSessionLookupRow>(
      `
        SELECT
          session.*,
          users.email AS user_email,
          users.password_hash AS user_password_hash,
          users.display_name AS user_display_name,
          users.status AS user_status,
          users.created_at AS user_created_at,
          users.updated_at AS user_updated_at,
          users.deleted_at AS user_deleted_at
        FROM user_sessions AS session
        JOIN users ON users.user_id = session.user_id
        WHERE session.token_hash = $1
      `,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      session: {
        user_session_id: row.user_session_id,
        user_id: row.user_id,
        token_hash: row.token_hash,
        status: row.status,
        expires_at: row.expires_at,
        last_seen_at: row.last_seen_at,
        revoked_at: row.revoked_at,
        client_metadata: row.client_metadata,
        created_at: row.created_at,
        updated_at: row.updated_at
      },
      user: {
        user_id: row.user_id,
        email: row.user_email,
        password_hash: row.user_password_hash,
        display_name: row.user_display_name,
        status: row.user_status,
        created_at: row.user_created_at,
        updated_at: row.user_updated_at,
        deleted_at: row.user_deleted_at
      }
    };
  }

  async touchLastSeen(userSessionId: string, seenAt: Date) {
    await this.database.query(
      `
        UPDATE user_sessions
        SET last_seen_at = $2,
            updated_at = $2
        WHERE user_session_id = $1
      `,
      [userSessionId, seenAt]
    );
  }

  async revoke(userSessionId: string, revokedAt: Date) {
    const result = await this.database.query<UserSessionRow>(
      `
        UPDATE user_sessions
        SET status = 'revoked',
            revoked_at = $2,
            updated_at = $2
        WHERE user_session_id = $1
        RETURNING *
      `,
      [userSessionId, revokedAt]
    );
    return result.rows[0] ?? null;
  }
}
