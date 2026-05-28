import { Request } from "express";
import { BaseController } from "../../../controllers/base.controller.js";
import type { ApiResult } from "../../../types/api-response.types.js";

export type VisibilityScoreReadPort = {
  getLatestVisibilityScore(domainId: number): Promise<ApiResult>;
  getVisibilityScoreHistory(domainId: number): Promise<ApiResult>;
  getVisibilityScoreTrend(domainId: number): Promise<ApiResult>;
};

export class VisibilityScoresController extends BaseController {
  constructor(private readonly visibilityScoreReadService: VisibilityScoreReadPort) {
    super();
  }

  async handleVisibilityScoreHistoryRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);

    const params = req.params as unknown as { domainId: number };
    const result = await this.visibilityScoreReadService.getVisibilityScoreHistory(params.domainId);

    this.logResponse(req, result.statusCode);
    return result;
  }

  async handleVisibilityScoreTrendRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);

    const params = req.params as unknown as { domainId: number };
    const result = await this.visibilityScoreReadService.getVisibilityScoreTrend(params.domainId);

    this.logResponse(req, result.statusCode);
    return result;
  }

  async handleVisibilityScoreRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);

    const params = req.params as unknown as { domainId: number };
    const result = await this.visibilityScoreReadService.getLatestVisibilityScore(params.domainId);

    this.logResponse(req, result.statusCode);
    return result;
  }
}
