import express, { type Router } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "./docs/openapi.js";
import { errorMiddleware } from "./middleware/error.middleware.js";
import type { ReadinessService } from "./observability/readiness.service.js";

export type CreateAppOptions = {
  analysisRouter: Router;
  readinessService?: Pick<ReadinessService, "check">;
};

export function createApp(options: CreateAppOptions) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/ready", async (_req, res) => {
    const result = options.readinessService
      ? await options.readinessService.check()
      : {
          status: "not_ready" as const,
          checks: {
            database: { status: "failed" as const },
            migrations: { status: "failed" as const },
            rabbitmq: { status: "failed" as const },
            queues: { status: "failed" as const }
          }
        };
    res.status(result.status === "ready" ? 200 : 503).json(result);
  });

  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use("/v1/analysis", options.analysisRouter);

  app.use(errorMiddleware);

  return app;
}
