import { Router, type RequestHandler } from "express";
import { validateBody, validateParams } from "../middleware/validate.middleware.js";
import { sendApiResult } from "../utils/api-response.js";
import { AnalysisController } from "./analysis.controller.js";
import {
  analysisRunParamsSchema,
  createAnalysisRequestSchema,
  validateIdempotencyKeyHeader
} from "./analysis.schemas.js";

export function createAnalysisRouter(
  controller: AnalysisController,
  ownershipMiddleware: RequestHandler
) {
  const router = Router();
  router.use(ownershipMiddleware);

  router.post(
    "/",
    validateIdempotencyKeyHeader,
    validateBody(createAnalysisRequestSchema),
    asyncApiHandler(controller.create)
  );
  router.get(
    "/runs/:analysisRunId",
    validateParams(analysisRunParamsSchema),
    asyncApiHandler(controller.status)
  );
  router.get(
    "/runs/:analysisRunId/report",
    validateParams(analysisRunParamsSchema),
    asyncApiHandler(controller.report)
  );
  return router;
}

function asyncApiHandler(
  handler: (request: Parameters<RequestHandler>[0]) => Promise<{
    statusCode: number;
    body: unknown;
  }>
): RequestHandler {
  return (request, response, next) => {
    handler(request)
      .then((result) => sendApiResult(response, result))
      .catch(next);
  };
}
