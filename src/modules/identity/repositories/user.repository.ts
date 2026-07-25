import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type { UserRow } from "../../../common/types/database.types.js";

export type CreateUserRecord = {
  email: string;
  passwordHash: string | null;
  displayName: string | null;
};

export class UserRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async create(input: CreateUserRecord) {
    const result = await this.database.query<UserRow>(
      `
        INSERT INTO users (email, password_hash, display_name)
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [input.email, input.passwordHash, input.displayName]
    );
    return result.rows[0] as UserRow;
  }

  async findById(userId: string) {
    const result = await this.database.query<UserRow>(
      "SELECT * FROM users WHERE user_id = $1",
      [userId]
    );
    return result.rows[0] ?? null;
  }

  async findActiveById(userId: string) {
    const result = await this.database.query<UserRow>(
      `
        SELECT *
        FROM users
        WHERE user_id = $1
          AND status = 'active'
          AND deleted_at IS NULL
      `,
      [userId]
    );
    return result.rows[0] ?? null;
  }

  async findByEmail(email: string) {
    const result = await this.database.query<UserRow>(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );
    return result.rows[0] ?? null;
  }
}
