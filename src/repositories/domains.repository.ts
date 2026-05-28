import { SQL_QUERIES } from "../db/sql-queries.js";
import type { DomainRow } from "../types/database.types.js";
import { normalizeDomain } from "../utils/domain-normalization.js";
import { BaseRepository } from "./base.repository.js";

export class DomainsRepository extends BaseRepository<DomainRow> {
  async upsertDomain(domain: string): Promise<DomainRow> {
    const normalizedDomain = normalizeDomain(domain);
    this.log(`Upserting domain: ${normalizedDomain}`);

    const row = await this.executeSingleQueryOrThrow<DomainRow>(
      SQL_QUERIES.domains.upsertDomain,
      [normalizedDomain],
      "Failed to upsert domain"
    );

    this.log(`Domain upserted successfully`, { domain_id: row.domain_id, domain: row.domain });
    return row;
  }

  async findDomainById(id: number): Promise<DomainRow | null> {
    this.log(`Finding domain by ID: ${id}`);

    return this.executeSingleQuery<DomainRow>(SQL_QUERIES.domains.findById, [id]);
  }

  async findDomainByName(domain: string): Promise<DomainRow | null> {
    const normalizedDomain = normalizeDomain(domain);
    this.log(`Finding domain by name: ${normalizedDomain}`);

    return this.executeSingleQuery<DomainRow>(SQL_QUERIES.domains.findByName, [normalizedDomain]);
  }

  async getActiveDomainByName(domain: string): Promise<DomainRow | null> {
    const normalizedDomain = normalizeDomain(domain);
    this.log(`Finding active domain by name: ${normalizedDomain}`);

    return this.executeSingleQuery<DomainRow>(SQL_QUERIES.domains.findActiveByName, [normalizedDomain]);
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
export { normalizeDomain };
