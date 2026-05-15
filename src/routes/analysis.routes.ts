import { Router } from "express";
import { z } from "zod";
import { validateBody, validateParams } from "../middleware/validate.middleware.js";
import { BaseRouter } from "./base.router.js";
import type { AnalysisController } from "../controllers/analysis.controller.js";

const requestSchema = z.object({
  domain: z.string().trim().min(1).max(253)
});

const jobParamsSchema = z.object({
  jobId: z.coerce.number().int().positive()
});

export class AnalysisRouter extends BaseRouter {
  private readonly router: Router;

  constructor(private readonly analysisController: AnalysisController, router: Router = Router()) {
    super();
    this.router = router;
    this.setupRoutes();
  }

  getRouter(): Router {
    return this.router;
  }

  private setupRoutes(): void {
    this.router.post(
      "/",
      validateBody(requestSchema),
      this.asyncHandler((req, res) => this.analysisController.handleAnalysisRequest(req, res))
    );
    this.router.get(
      "/jobs/:jobId",
      validateParams(jobParamsSchema),
      this.asyncHandler((req, res) => this.analysisController.handleJobStatusRequest(req, res))
    );
  }
}

export function createAnalysisRouter(analysisController: AnalysisController): Router {
  return new AnalysisRouter(analysisController).getRouter();
}
