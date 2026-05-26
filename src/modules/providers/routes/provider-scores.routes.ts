import { Router } from "express";
import { z } from "zod";
import { PROVIDERS } from "../../../config/constants.js";
import { validateParams } from "../../../middleware/validate.middleware.js";
import { BaseRouter } from "../../../routes/base.router.js";
import type { ProviderScoresController } from "../controllers/provider-scores.controller.js";

const domainParamsSchema = z.object({
  domainId: z.coerce.number().int().positive()
});

const providerParamsSchema = domainParamsSchema.extend({
  llmName: z.enum(PROVIDERS)
});

export class ProviderScoresRouter extends BaseRouter {
  private readonly router: Router;

  constructor(private readonly providerScoresController: ProviderScoresController, router: Router = Router()) {
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
      validateParams(providerParamsSchema),
      this.apiHandler((req) => this.providerScoresController.handleProviderScoresRequest(req))
    );
    this.router.get(
      "/:domainId/providers/:llmName/history",
      validateParams(providerParamsSchema),
      this.apiHandler((req) => this.providerScoresController.handleProviderHistoryRequest(req))
    );
    this.router.get(
      "/:domainId/provider-scores",
      validateParams(domainParamsSchema),
      this.apiHandler((req) => this.providerScoresController.handleProviderComparisonRequest(req))
    );
  }
}

export function createProviderScoresRouter(providerScoresController: ProviderScoresController): Router {
  return new ProviderScoresRouter(providerScoresController).getRouter();
}
