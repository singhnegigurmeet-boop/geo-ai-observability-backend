import { SQL_QUERIES } from "../../../db/sql-queries.js";
import { BaseRepository } from "../../../repositories/base.repository.js";
import type {
  DiscoveryRequestKind,
  DiscoveryRequestRow,
  DiscoveryRequestStatus
} from "../../../types/database.types.js";
import { normalizeDomain } from "../../../utils/domain-normalization.js";
import type { DiscoveryRequest } from "../types/discovery-request.js";

const DISCOVERY_REQUEST_STATUSES = new Set<DiscoveryRequestStatus>(["pending", "rejected", "resolved"]);

export type PendingDiscoveryFilters = {
  kind?: DiscoveryRequestKind;
  contextCategoryId?: number;
  limit?: number;
  offset?: number;
};

export class DiscoveryRequestsRepository extends BaseRepository<DiscoveryRequestRow> {
  async createDiscoveryRequest(input: DiscoveryRequest): Promise<DiscoveryRequestRow> {
    const contextDomain = input.kind === "domain" ? null : normalizeDomain(input.contextDomain);
    const requestedValue = input.kind === "domain" ? normalizeDomain(input.requestedValue) : input.requestedValue.trim();

    return this.executeSingleQueryOrThrow<DiscoveryRequestRow>(
      SQL_QUERIES.discoveryRequests.insert,
      [
        input.kind,
        requestedValue,
        contextDomain,
        input.contextCategoryId ?? null,
        input.kind === "product" ? input.contextBrandId ?? null : null,
        input.notes?.trim() || null
      ],
      "Failed to create discovery request"
    );
  }

  async listPendingDiscoveryRequests(filters: PendingDiscoveryFilters = {}): Promise<DiscoveryRequestRow[]> {
    return this.executeQuery<DiscoveryRequestRow>(SQL_QUERIES.discoveryRequests.listPending, [
      filters.kind ?? null,
      filters.contextCategoryId ?? null,
      filters.limit ?? 100,
      filters.offset ?? 0
    ]);
  }

  async updateDiscoveryRequestStatus(
    requestId: number,
    status: DiscoveryRequestStatus
  ): Promise<DiscoveryRequestRow | null> {
    if (!DISCOVERY_REQUEST_STATUSES.has(status)) {
      throw new Error(`Invalid discovery request status: ${status}`);
    }

    return this.executeSingleQuery<DiscoveryRequestRow>(SQL_QUERIES.discoveryRequests.updateStatus, [
      requestId,
      status
    ]);
  }
}

export const discoveryRequestsRepository = new DiscoveryRequestsRepository();
