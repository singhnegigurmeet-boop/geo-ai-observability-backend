import { SQL_QUERIES } from "../db/sql-queries.js";
import type { DomainRow } from "../types/database.types.js";
import { BaseRepository } from "./base.repository.js";

export class DomainsRepository extends BaseRepository<DomainRow> {
  async upsertDomain(domain: string): Promise<DomainRow> {
    this.log(`Upserting domain: ${domain}`);

    const row = await this.executeSingleQueryOrThrow<DomainRow>(
      SQL_QUERIES.domains.upsertDomain,
      [domain],
      "Failed to upsert domain"
    );

    this.log(`Domain upserted successfully`, { id: row.id, domain: row.domain });
    return row;
  }

  async findDomainById(id: number): Promise<DomainRow | null> {
    this.log(`Finding domain by ID: ${id}`);

    return this.executeSingleQuery<DomainRow>(SQL_QUERIES.domains.findById, [id]);
  }

  async findDomainByName(domain: string): Promise<DomainRow | null> {
    this.log(`Finding domain by name: ${domain}`);

    return this.executeSingleQuery<DomainRow>(SQL_QUERIES.domains.findByName, [domain]);
  }

  async getAllDomains(limit: number = 100, offset: number = 0): Promise<DomainRow[]> {
    this.log(`Fetching all domains`, { limit, offset });

    return this.executeQuery<DomainRow>(SQL_QUERIES.domains.findAll, [limit, offset]);
  }

  async countDomains(): Promise<number> {
    const row = await this.executeSingleQuery<{ count: string }>(SQL_QUERIES.domains.count);
    return parseInt(row?.count || "0", 10);
  }
}

export const domainsRepository = new DomainsRepository();
