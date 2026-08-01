import type { Request } from "express";
import { requireOwnershipContext } from "../../../common/ownership/ownership-context.middleware.js";
import { apiResult } from "../../../utils/api-response.js";
import type { CreateAnalysisRequest, HierarchyNavigationRequest } from "../schemas/analysis.schemas.js";
import { parseIdempotencyKey } from "../schemas/analysis.schemas.js";
import type { AnalysisService } from "../services/analysis.service.js";

type AnalysisServiceContract = Pick<
  AnalysisService,
  "create" | "continueHierarchy" | "preview" | "getStatus" | "getRequestStatus" | "getReport" | "cancel"
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

  continueHierarchy = async (request: Request) => {
    const owner = requireOwnershipContext(request);
    const idempotencyKey = parseIdempotencyKey(request.get("idempotency-key"));
    const result = await this.analyses.continueHierarchy(
      request.body as HierarchyNavigationRequest,
      idempotencyKey,
      owner
    );
    return apiResult(result.source === "database" ? 200 : 202, result);
  };

  preview = async (request: Request) => {
    const owner = requireOwnershipContext(request);
    const result = await this.analyses.preview(
      request.body as CreateAnalysisRequest,
      owner
    );
    return apiResult(200, result);
  };

  status = async (request: Request) => {
    const owner = requireOwnershipContext(request);
    const result = await this.analyses.getStatus(
      request.params.analysisRunId as string,
      owner
    );
    return apiResult(200, result);
  };

  requestStatus = async (request: Request) => {
    const owner = requireOwnershipContext(request);
    return apiResult(200, await this.analyses.getRequestStatus(request.params.preAnalysisRequestId as string, owner));
  };

  report = async (request: Request) => {
    const owner = requireOwnershipContext(request);
    const result = await this.analyses.getReport(
      request.params.analysisRunId as string,
      owner
    );
    return apiResult(200, result);
  };

  cancel = async (request: Request) => {
    const owner = requireOwnershipContext(request);
    const result = await this.analyses.cancel(
      request.params.analysisRunId as string,
      owner
    );
    return apiResult(200, result);
  };
}
