import express from "express";
import swaggerUi from "swagger-ui-express";
import { AnalysisController } from "./modules/analysis/controllers/analysis.controller.js";
import { DiscoveryController } from "./modules/discovery/controllers/discovery.controller.js";
import { openApiDocument } from "./docs/openapi.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { createAnalysisRouter } from "./modules/analysis/routes/analysis.routes.js";
import { createDiscoveryRouter } from "./modules/discovery/routes/discovery.routes.js";
import type { AnalysisCommandPort, AnalysisStatusPort } from "./modules/analysis/controllers/analysis.controller.js";
import type { DiscoveryCommandPort } from "./modules/discovery/controllers/discovery.controller.js";

export type AppDependencies = {
  analysisCommandService: AnalysisCommandPort;
  analysisStatusService: AnalysisStatusPort;
  discoveryCommandService: DiscoveryCommandPort;
};

export function createApp(dependencies: AppDependencies) {
  const app = express();
  const analysisController = new AnalysisController({
    commandService: dependencies.analysisCommandService,
    statusService: dependencies.analysisStatusService
  });
  const discoveryController = new DiscoveryController(dependencies.discoveryCommandService);

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use("/v1/analysis", createAnalysisRouter(analysisController));
  app.use("/v1/discovery", createDiscoveryRouter(discoveryController));

  app.use(errorMiddleware);

  return app;
}
