import type { DatabaseExecutor } from "../db/database-executor.js";
import { ApplicationError } from "../errors/application-error.js";
import type { DomainRow } from "../types/database.types.js";

export class DomainRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findByNormalizedDomain(normalizedDomain: string) {
    const result = await this.database.query<DomainRow>(
      `
        SELECT *
        FROM domains
        WHERE normalized_domain = $1
          AND is_active
      `,
      [normalizedDomain]
    );
    return result.rows[0] ?? null;
  }

  async findOrCreate(normalizedDomain: string, displayDomain: string) {
    const inserted = await this.database.query<DomainRow>(
      `
        INSERT INTO domains (normalized_domain, display_domain)
        VALUES ($1, $2)
        ON CONFLICT (normalized_domain) DO NOTHING
        RETURNING *
      `,
      [normalizedDomain, displayDomain]
    );
    if (inserted.rows[0]) {
      return inserted.rows[0];
    }

    const existing = await this.findByNormalizedDomain(normalizedDomain);
    if (!existing) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Domain is not active"
      );
    }
    return existing;
  }
}
