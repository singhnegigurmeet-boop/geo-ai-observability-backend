import type { DiscoveryRequest } from "../types/discovery-request.js";

export class DiscoveryCommandService {
  async createDiscoveryRequest(request: DiscoveryRequest) {
    // TODO: V6_REBUILD_REQUIRED persist pending discovery work without running analysis.
    return {
      statusCode: 501,
      body: {
        status: "not_implemented",
        code: "V6_DISCOVERY_REBUILD_REQUIRED",
        message: "Discovery requests are not persisted yet and do not run analysis.",
        request
      }
    };
  }
}

