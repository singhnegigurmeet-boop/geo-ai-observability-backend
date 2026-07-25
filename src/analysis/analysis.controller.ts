import type { Request } from "express";
import { requireOwnershipContext } from "../ownership/ownership-context.middleware.js";
import { apiResult } from "../utils/api-response.js";
import type { CreateAnalysisRequest } from "./analysis.schemas.js";
import { parseIdempotencyKey } from "./analysis.schemas.js";
import type { AnalysisService } from "./analysis.service.js";

type AnalysisServiceContract = Pick<
  AnalysisService,
  "create" | "getStatus" | "getReport"
>;

export class AnalysisController {
  constructor(private readonly analyses: AnalysisServiceContract) {}

  create = async (request: Request) => {
    const owner = requireOwnershipContext(request);
    const idempotencyKey = parseIdempotencyKey(
      request.get("idempotency-key")
    );
    const result = await this.analyses.create(
      request.body as CreateAnalysisRequest,
      idempotencyKey,
      owner
    );
    return apiResult(202, result);
  };

  status = async (request: Request) => {
    const owner = requireOwnershipContext(request);
    const result = await this.analyses.getStatus(
      request.params.analysisRunId as string,
      owner
    );
    return apiResult(200, result);
  };

  report = async (request: Request) => {
    const owner = requireOwnershipContext(request);
    const result = await this.analyses.getReport(
      request.params.analysisRunId as string,
      owner
    );
    return apiResult(200, result);
  };
}
