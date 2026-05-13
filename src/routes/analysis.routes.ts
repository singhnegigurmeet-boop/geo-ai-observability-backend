import { Router, Request, Response } from "express";
import { z } from "zod";
import { BaseRouter } from "./base.router.js";
import type { AnalysisApiService } from "../services/analysis-api.service.js";

const requestSchema = z.object({
  domain: z.string().trim().min(1).max(253)
});

const jobParamsSchema = z.object({
  jobId: z.coerce.number().int().positive()
});

export class AnalysisRouter extends BaseRouter {
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
    this.router.post("/", this.asyncHandler((req, res) => this.handleAnalysisRequest(req, res)));
    this.router.get("/jobs/:jobId", this.asyncHandler((req, res) => this.handleJobStatusRequest(req, res)));
  }

  private async handleAnalysisRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const input = this.validateBody<{ domain: string }>(req, requestSchema);
    this.log(`Processing analysis request for domain: ${input.domain}`);

    const result = await this.analysisService.enqueueOrReturnCachedAnalysis(input.domain);

    this.logResponse(req, result.statusCode);
    res.status(result.statusCode).json(result.body);
  }

  private async handleJobStatusRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const params = this.validateParams<{ jobId: number }>(req, jobParamsSchema);
    this.log(`Checking analysis job status: ${params.jobId}`);

    const result = await this.analysisService.getAnalysisJobStatus(params.jobId);

    this.logResponse(req, result.statusCode);
    res.status(result.statusCode).json(result.body);
  }

  private log(message: string, data?: unknown): void {
    console.log(`[AnalysisRouter] ${message}`, data);
  }
}

export function createAnalysisRouter(analysisService: AnalysisApiService): Router {
  return new AnalysisRouter(analysisService).getRouter();
}
