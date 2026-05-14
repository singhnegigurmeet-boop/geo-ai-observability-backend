import { Router } from "express";
import { z } from "zod";
import { validateParams } from "../middleware/validate.middleware.js";
import { BaseRouter } from "./base.router.js";
import type { VisibilityScoresController } from "../controllers/visibility-scores.controller.js";

const domainParamsSchema = z.object({
  domainId: z.coerce.number().int().positive()
});

export class VisibilityScoresRouter extends BaseRouter {
  private readonly router: Router;

  constructor(private readonly visibilityScoresController: VisibilityScoresController, router: Router = Router()) {
    super();
    this.router = router;
    this.setupRoutes();
  }

  getRouter(): Router {
    return this.router;
  }

  private setupRoutes(): void {
    this.router.get(
      "/:domainId/visibility-score/history",
      validateParams(domainParamsSchema),
      this.asyncHandler((req, res) => this.visibilityScoresController.handleVisibilityScoreHistoryRequest(req, res))
    );
    this.router.get(
      "/:domainId/visibility-score/trend",
      validateParams(domainParamsSchema),
      this.asyncHandler((req, res) => this.visibilityScoresController.handleVisibilityScoreTrendRequest(req, res))
    );
    this.router.get(
      "/:domainId/visibility-score",
      validateParams(domainParamsSchema),
      this.asyncHandler((req, res) => this.visibilityScoresController.handleVisibilityScoreRequest(req, res))
    );
  }
}

export function createVisibilityScoresRouter(visibilityScoresController: VisibilityScoresController): Router {
  return new VisibilityScoresRouter(visibilityScoresController).getRouter();
}
