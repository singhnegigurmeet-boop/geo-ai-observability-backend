import { Router, Request, Response } from "express";
import { z } from "zod";
import { PROVIDERS } from "../config/constants.js";
import { BaseRouter } from "./base.router.js";
import type { AnalysisApiService } from "../services/analysis-api.service.js";

const domainParamsSchema = z.object({
  domainId: z.coerce.number().int().positive()
});

const providerParamsSchema = domainParamsSchema.extend({
  llmName: z.enum(PROVIDERS)
});

export class DomainsRouter extends BaseRouter {
  private readonly router: Router;

  constructor(private readonly analysisService: AnalysisApiService, router: Router = Router()) {
    super();
    this.router = router;
    this.setupRoutes();
  }

  getRouter(): Router {
    return this.router;
  }

  private setupRoutes(): void {
    this.router.get(
      "/:domainId/providers/:llmName/scores",
      this.asyncHandler((req, res) => this.handleProviderScoresRequest(req, res))
    );
    this.router.get(
      "/:domainId/provider-scores",
      this.asyncHandler((req, res) => this.handleProviderComparisonRequest(req, res))
    );
    this.router.get(
      "/:domainId/visibility-score",
      this.asyncHandler((req, res) => this.handleVisibilityScoreRequest(req, res))
    );
  }

  private async handleProviderScoresRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const params = this.validateParams<{ domainId: number; llmName: (typeof PROVIDERS)[number] }>(
      req,
      providerParamsSchema
    );
    const result = await this.analysisService.getLatestProviderScores(params.domainId, params.llmName);

    this.logResponse(req, result.statusCode);
    res.status(result.statusCode).json(result.body);
  }

  private async handleProviderComparisonRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const params = this.validateParams<{ domainId: number }>(req, domainParamsSchema);
    const result = await this.analysisService.getLatestProviderScoreComparison(params.domainId);

    this.logResponse(req, result.statusCode);
    res.status(result.statusCode).json(result.body);
  }

  private async handleVisibilityScoreRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const params = this.validateParams<{ domainId: number }>(req, domainParamsSchema);
    const result = await this.analysisService.getLatestVisibilityScore(params.domainId);

    this.logResponse(req, result.statusCode);
    res.status(result.statusCode).json(result.body);
  }
}

export function createDomainsRouter(analysisService: AnalysisApiService): Router {
  return new DomainsRouter(analysisService).getRouter();
}
