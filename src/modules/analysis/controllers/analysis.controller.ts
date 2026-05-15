import { Request, Response } from "express";
import { BaseController } from "../../../controllers/base.controller.js";
import { sendApiResult } from "../../../utils/api-response.js";
import type { ApiResult } from "../../../types/api-response.types.js";

export type AnalysisCommandPort = {
  enqueueOrReturnCachedAnalysis(rawDomain: string, ipAddress: string): Promise<ApiResult>;
};

export type AnalysisStatusPort = {
  getAnalysisJobStatus(jobId: number): Promise<ApiResult>;
  getAnalysisJobDiffs(jobId: number): Promise<ApiResult>;
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

  async handleAnalysisRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const input = req.body as { domain: string };
    this.log(`Processing analysis request for domain: ${input.domain}`);

    const result = await this.dependencies.commandService.enqueueOrReturnCachedAnalysis(input.domain, this.getClientIp(req));

    this.logResponse(req, result.statusCode);
    sendApiResult(res, result);
  }

  async handleJobStatusRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const params = req.params as unknown as { jobId: number };
    this.log(`Checking analysis job status: ${params.jobId}`);

    const result = await this.dependencies.statusService.getAnalysisJobStatus(params.jobId);

    this.logResponse(req, result.statusCode);
    sendApiResult(res, result);
  }

  async handleJobDiffsRequest(req: Request, res: Response): Promise<void> {
    this.logRequest(req);

    const params = req.params as unknown as { jobId: number };
    this.log(`Checking analysis job diffs: ${params.jobId}`);

    const result = await this.dependencies.statusService.getAnalysisJobDiffs(params.jobId);

    this.logResponse(req, result.statusCode);
    sendApiResult(res, result);
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
