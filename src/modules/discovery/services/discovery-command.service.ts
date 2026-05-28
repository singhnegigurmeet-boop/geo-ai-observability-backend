import type { DiscoveryRequest } from "../types/discovery-request.js";
import type { DiscoveryRequestsRepository } from "../repositories/discovery-requests.repository.js";

export class DiscoveryCommandService {
  constructor(private readonly discoveryRequestsRepository: DiscoveryRequestsRepository) {}

  async createDiscoveryRequest(request: DiscoveryRequest) {
    const row = await this.discoveryRequestsRepository.createDiscoveryRequest(request);

    return {
      statusCode: 201,
      body: {
        status: "created",
        message: "Discovery request was queued for manual/admin/crawler verification.",
        discovery_request: row,
        analysis_started: false
      }
    };
  }
}
