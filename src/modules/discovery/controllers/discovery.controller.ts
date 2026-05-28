import type { Request } from "express";
import { BaseController } from "../../../controllers/base.controller.js";
import type { ApiResult } from "../../../types/api-response.types.js";
import type { DiscoveryRequest } from "../types/discovery-request.js";

export type DiscoveryCommandPort = {
  createDiscoveryRequest(request: DiscoveryRequest): Promise<ApiResult>;
};

export class DiscoveryController extends BaseController {
  constructor(private readonly discoveryCommandService: DiscoveryCommandPort) {
    super();
  }

  async handleDiscoveryRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);

    const result = await this.discoveryCommandService.createDiscoveryRequest(req.body as DiscoveryRequest);

    this.logResponse(req, result.statusCode);
    return result;
  }
}

