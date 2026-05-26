import { Request } from "express";
import { BaseController } from "../../../controllers/base.controller.js";
import type { ApiResult } from "../../../types/api-response.types.js";

export type AnalysisCommandPort = {
  enqueueOrReturnCachedAnalysis(rawDomain: string, ipAddress: string): Promise<ApiResult>;
};

export type AnalysisStatusPort = {
  getAnalysisRunStatus(analysisRunId: number): Promise<ApiResult>;
  getAnalysisRunDiffs(analysisRunId: number): Promise<ApiResult>;
};

export class AnalysisController extends BaseController {
  constructor(
    private readonly dependencies: {
      commandService: AnalysisCommandPort;
      statusService: AnalysisStatusPort;
    }
  ) {
    super();
  }

  async handleAnalysisRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);

    const input = req.body as { domain: string };
    this.log(`Processing analysis request for domain: ${input.domain}`);

    const result = await this.dependencies.commandService.enqueueOrReturnCachedAnalysis(input.domain, this.getClientIp(req));

    this.logResponse(req, result.statusCode);
    return result;
  }

  async handleRunStatusRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);

    const params = req.params as unknown as { analysisRunId: number };
    this.log(`Checking analysis run status: ${params.analysisRunId}`);

    const result = await this.dependencies.statusService.getAnalysisRunStatus(params.analysisRunId);

    this.logResponse(req, result.statusCode);
    return result;
  }

  async handleRunDiffsRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);

    const params = req.params as unknown as { analysisRunId: number };
    this.log(`Checking analysis run diffs: ${params.analysisRunId}`);

    const result = await this.dependencies.statusService.getAnalysisRunDiffs(params.analysisRunId);

    this.logResponse(req, result.statusCode);
    return result;
  }

  private log(message: string, data?: unknown): void {
    const logMessage = `[AnalysisController] ${message}`;
    if (data !== undefined) {
      console.log(logMessage, data);
      return;
    }

    console.log(logMessage);
  }
}
