import { Router } from "express";
import { z } from "zod";
import { validateBody, validateParams } from "../../../middleware/validate.middleware.js";
import { BaseRouter } from "../../../routes/base.router.js";
import type { SchedulesController } from "../controllers/schedules.controller.js";

const createScheduleSchema = z.object({
  domain: z.string().trim().min(1).max(253),
  cadence: z.literal("weekly").optional(),
  enabled: z.boolean().optional(),
  next_run_at: z.string().datetime().optional()
});

const scheduleParamsSchema = z.object({
  scheduleId: z.coerce.number().int().positive()
});

const updateScheduleSchema = z.object({
  enabled: z.boolean()
});

export class SchedulesRouter extends BaseRouter {
  private readonly router: Router;

  constructor(private readonly schedulesController: SchedulesController, router: Router = Router()) {
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
      validateBody(createScheduleSchema),
      this.apiHandler((req) => this.schedulesController.handleCreateScheduleRequest(req))
    );
    this.router.get(
      "/",
      this.apiHandler((req) => this.schedulesController.handleListSchedulesRequest(req))
    );
    this.router.patch(
      "/:scheduleId",
      validateParams(scheduleParamsSchema),
      validateBody(updateScheduleSchema),
      this.apiHandler((req) => this.schedulesController.handleSetScheduleEnabledRequest(req))
    );
  }
}

export function createSchedulesRouter(schedulesController: SchedulesController): Router {
  return new SchedulesRouter(schedulesController).getRouter();
}
