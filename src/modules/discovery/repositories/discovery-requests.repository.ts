import { SQL_QUERIES } from "../../../db/sql-queries.js";
import { normalizeDomain } from "../../../repositories/domains.repository.js";
import { BaseRepository } from "../../../repositories/base.repository.js";
import type {
  DiscoveryRequestKind,
  DiscoveryRequestRow,
  DiscoveryRequestStatus
} from "../../../types/database.types.js";
import type { DiscoveryRequest } from "../types/discovery-request.js";

export type PendingDiscoveryFilters = {
  kind?: DiscoveryRequestKind;
  categoryId?: number;
  limit?: number;
  offset?: number;
};

export class DiscoveryRequestsRepository extends BaseRepository<DiscoveryRequestRow> {
  async createDiscoveryRequest(input: DiscoveryRequest): Promise<DiscoveryRequestRow> {
    const domain = normalizeDomain(input.domain);
    const brandName = input.kind === "brand" ? input.brandName.trim() : null;
    const productName = input.kind === "product" ? input.productName.trim() : null;
    const brandId = input.kind === "product" ? input.brandId ?? null : null;

    return this.executeSingleQueryOrThrow<DiscoveryRequestRow>(
      SQL_QUERIES.discoveryRequests.insert,
      [
        input.kind,
        domain,
        input.categoryId ?? null,
        brandId,
        brandName,
        productName,
        input.notes?.trim() || null
      ],
      "Failed to create discovery request"
    );
  }

  async listPendingDiscoveryRequests(filters: PendingDiscoveryFilters = {}): Promise<DiscoveryRequestRow[]> {
    return this.executeQuery<DiscoveryRequestRow>(SQL_QUERIES.discoveryRequests.listPending, [
      filters.kind ?? null,
      filters.categoryId ?? null,
      filters.limit ?? 100,
      filters.offset ?? 0
    ]);
  }

  async updateDiscoveryRequestStatus(
    requestId: number,
    status: DiscoveryRequestStatus
  ): Promise<DiscoveryRequestRow | null> {
    return this.executeSingleQuery<DiscoveryRequestRow>(SQL_QUERIES.discoveryRequests.updateStatus, [
      requestId,
      status
    ]);
  }
}

export const discoveryRequestsRepository = new DiscoveryRequestsRepository();
