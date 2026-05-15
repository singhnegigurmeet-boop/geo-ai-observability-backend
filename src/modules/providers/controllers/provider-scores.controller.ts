import { Request, Response } from "express";
import { PROVIDERS } from "../../../config/constants.js";
import { BaseController } from "../../../controllers/base.controller.js";
import { sendApiResult } from "../../../utils/api-response.js";
import type { ApiResult } from "../../../types/api-response.types.js";
import type { ProviderName } from "../../../config/constants.js";

export type ProviderScoresPort = {
  getLatestProviderScores(domainId: number, llmName: ProviderName): Promise<ApiResult>;
  getProviderScoreHistory(domainId: number, llmName: ProviderName): Promise<ApiResult>;
  getLatestProviderScoreComparison(domainId: number): Promise<ApiResult>;
};

export class ProviderScoresController extends BaseController {
  constructor(private readonly providerScoresService: ProviderScoresPort) {
    super();
  }

  async handleProviderScoresRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const params = req.params as unknown as { domainId: number; llmName: (typeof PROVIDERS)[number] };
    const result = await this.providerScoresService.getLatestProviderScores(params.domainId, params.llmName);

    this.logResponse(req, result.statusCode);
    sendApiResult(res, result);
  }

  async handleProviderHistoryRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const params = req.params as unknown as { domainId: number; llmName: (typeof PROVIDERS)[number] };
    const result = await this.providerScoresService.getProviderScoreHistory(params.domainId, params.llmName);

    this.logResponse(req, result.statusCode);
    sendApiResult(res, result);
  }

  async handleProviderComparisonRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const params = req.params as unknown as { domainId: number };
    const result = await this.providerScoresService.getLatestProviderScoreComparison(params.domainId);

    this.logResponse(req, result.statusCode);
    sendApiResult(res, result);
  }
}
