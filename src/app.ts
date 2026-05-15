import express from "express";
import swaggerUi from "swagger-ui-express";
import { AnalysisController } from "./modules/analysis/controllers/analysis.controller.js";
import { ProviderScoresController } from "./modules/providers/controllers/provider-scores.controller.js";
import { SchedulesController } from "./modules/scheduler/controllers/schedules.controller.js";
import { VisibilityScoresController } from "./modules/visibility/controllers/visibility-scores.controller.js";
import { openApiDocument } from "./docs/openapi.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { createAnalysisRouter } from "./modules/analysis/routes/analysis.routes.js";
import { createProviderScoresRouter } from "./modules/providers/routes/provider-scores.routes.js";
import { createSchedulesRouter } from "./modules/scheduler/routes/schedules.routes.js";
import { createVisibilityScoresRouter } from "./modules/visibility/routes/visibility-scores.routes.js";
import type { AnalysisCommandPort, AnalysisStatusPort } from "./modules/analysis/controllers/analysis.controller.js";
import type { ProviderScoresPort } from "./modules/providers/controllers/provider-scores.controller.js";
import type { ScheduleManagementPort } from "./modules/scheduler/controllers/schedules.controller.js";
import type { VisibilityScoreReadPort } from "./modules/visibility/controllers/visibility-scores.controller.js";

export type AppDependencies = {
  analysisCommandService: AnalysisCommandPort;
  analysisStatusService: AnalysisStatusPort;
  providerScoresService: ProviderScoresPort;
  scheduleManagementService: ScheduleManagementPort;
  visibilityScoreReadService: VisibilityScoreReadPort;
};

export function createApp(dependencies: AppDependencies) {
  const app = express();
  const analysisController = new AnalysisController({
    commandService: dependencies.analysisCommandService,
    statusService: dependencies.analysisStatusService
  });
  const providerScoresController = new ProviderScoresController(dependencies.providerScoresService);
  const schedulesController = new SchedulesController(dependencies.scheduleManagementService);
  const visibilityScoresController = new VisibilityScoresController(dependencies.visibilityScoreReadService);

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use("/v1/analysis", createAnalysisRouter(analysisController));
  app.use("/v1/schedules", createSchedulesRouter(schedulesController));
  app.use("/v1/domains", createProviderScoresRouter(providerScoresController));
  app.use("/v1/domains", createVisibilityScoresRouter(visibilityScoresController));

  app.use(errorMiddleware);

  return app;
}
