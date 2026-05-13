import { query } from "../lib/postgres.js";
import type { DomainRow } from "../types/database.types.js";
import { BaseRepository } from "./base.repository.js";

export class DomainsRepository extends BaseRepository<DomainRow> {
  async upsertDomain(domain: string): Promise<DomainRow> {
    this.log(`Upserting domain: ${domain}`);

    const sql = `
      INSERT INTO domains (domain)
      VALUES ($1)
      ON CONFLICT (domain)
      DO UPDATE SET updated_at = now()
      RETURNING id, domain, created_at, updated_at
    `;

    const row = await this.executeSingleQueryOrThrow<DomainRow>(
      sql,
      [domain],
      "Failed to upsert domain"
    );

    this.log(`Domain upserted successfully`, { id: row.id, domain: row.domain });
    return row;
  }

  async findDomainById(id: number): Promise<DomainRow | null> {
    this.log(`Finding domain by ID: ${id}`);

    const sql = `SELECT * FROM domains WHERE id = $1`;
    return this.executeSingleQuery<DomainRow>(sql, [id]);
  }

  async findDomainByName(domain: string): Promise<DomainRow | null> {
    this.log(`Finding domain by name: ${domain}`);

    const sql = `SELECT * FROM domains WHERE domain = $1`;
    return this.executeSingleQuery<DomainRow>(sql, [domain]);
  }

  async getAllDomains(limit: number = 100, offset: number = 0): Promise<DomainRow[]> {
    this.log(`Fetching all domains`, { limit, offset });

    const sql = `
      SELECT * FROM domains
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `;
    return this.executeQuery<DomainRow>(sql, [limit, offset]);
  }

  async countDomains(): Promise<number> {
    const sql = `SELECT COUNT(*) as count FROM domains`;
    const result = await query<{ count: string }>(sql, []);
    return parseInt(result.rows[0]?.count || "0", 10);
  }
}

export const domainsRepository = new DomainsRepository();
