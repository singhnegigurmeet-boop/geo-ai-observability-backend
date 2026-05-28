import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../../../middleware/validate.middleware.js";
import { BaseRouter } from "../../../routes/base.router.js";
import type { DiscoveryController } from "../controllers/discovery.controller.js";

const baseDiscoverySchema = {
  requestedValue: z.string().trim().min(1).max(253),
  contextCategoryId: z.number().int().positive().optional(),
  notes: z.string().trim().max(2000).optional()
};

const contextDomainSchema = z.string().trim().min(1).max(253);

const discoveryRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("domain"),
      ...baseDiscoverySchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("brand"),
      ...baseDiscoverySchema,
      contextDomain: contextDomainSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("product"),
      ...baseDiscoverySchema,
      contextDomain: contextDomainSchema,
      contextBrandId: z.number().int().positive().optional()
    })
    .strict()
]);

export class DiscoveryRouter extends BaseRouter {
  private readonly router: Router;

  constructor(private readonly discoveryController: DiscoveryController, router: Router = Router()) {
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
      validateBody(discoveryRequestSchema),
      this.apiHandler((req) => this.discoveryController.handleDiscoveryRequest(req))
    );
  }
}

export function createDiscoveryRouter(discoveryController: DiscoveryController): Router {
  return new DiscoveryRouter(discoveryController).getRouter();
}
