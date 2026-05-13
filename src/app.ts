import express from "express";
import { errorMiddleware } from "./middleware/error.middleware.js";
import { createAnalysisRouter } from "./routes/analysis.routes.js";
import { createDomainsRouter } from "./routes/domains.routes.js";
import type { AnalysisApiService } from "./services/analysis-api.service.js";

export function createApp(apiService: AnalysisApiService) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/v1/analysis", createAnalysisRouter(apiService));
  app.use("/v1/domains", createDomainsRouter(apiService));

  app.use(errorMiddleware);

  return app;
}
