import { Router } from "express";
import { z } from "zod";
import { validateBody, validateParams } from "../../../middleware/validate.middleware.js";
import { BaseRouter } from "../../../routes/base.router.js";
import type { AnalysisController } from "../controllers/analysis.controller.js";

const requestSchema = z.object({
  domain: z.string().trim().min(1).max(253)
});

const runParamsSchema = z.object({
  analysisRunId: z.coerce.number().int().positive()
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
      this.apiHandler((req) => this.analysisController.handleAnalysisRequest(req))
    );
    this.router.get(
      "/runs/:analysisRunId",
      validateParams(runParamsSchema),
      this.apiHandler((req) => this.analysisController.handleRunStatusRequest(req))
    );
    this.router.get(
      "/runs/:analysisRunId/diffs",
      validateParams(runParamsSchema),
      this.apiHandler((req) => this.analysisController.handleRunDiffsRequest(req))
    );
  }
}

export function createAnalysisRouter(analysisController: AnalysisController): Router {
  return new AnalysisRouter(analysisController).getRouter();
}
