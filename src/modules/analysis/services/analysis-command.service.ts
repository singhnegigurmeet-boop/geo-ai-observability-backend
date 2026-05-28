import { BaseService } from "../../../services/base.service.js";
import { apiError } from "../../../utils/api-response.js";
import type { AnalysisRunItemsRepository } from "../repositories/analysis-run-items.repository.js";
import type { AnalysisRunsRepository } from "../repositories/analysis-runs.repository.js";
import type { AnalysisRequest } from "../types/v6-analysis-request.js";
import type { AnalysisRunJobPayload } from "../../../types/queue.types.js";
import {
  AnalysisRequestValidationError,
  type ValidatedAnalysisPath,
  type AnalysisRequestValidationService
} from "./analysis-request-validation.service.js";

export class AnalysisCommandService extends BaseService {
  constructor(
    private readonly validationService: AnalysisRequestValidationService,
    private readonly analysisRunsRepository: AnalysisRunsRepository,
    private readonly analysisRunItemsRepository: AnalysisRunItemsRepository,
    private readonly analysisRunQueue: { add(name: string, data: AnalysisRunJobPayload): Promise<unknown> }
  ) {
    super();
  }

  async enqueueAnalysis(request: AnalysisRequest, ipAddress: string) {
    try {
      const validation = await this.validationService.validateRequest(request);

      if (validation.useContextSelectionRequired) {
        return apiError(422, "Use context selection is required before product-level analysis can run", {
          domain: validation.normalizedDomain,
          blocking_reason: "PRODUCT_USE_CONTEXT_SELECTION_NOT_IMPLEMENTED",
          message:
            "A product was selected without useContextIds. LLM-assisted top use_context selection is not implemented yet.",
          validation
        });
      }

      const pathIds = this.getRunItemPathIds(validation.paths);
      const { analysisRun, runItems } = await this.analysisRunsRepository.createAnalysisRunWithItems({
        domainId: validation.domain.domain_id,
        requestPayload: request,
        pathIds,
        status: "queued"
      });

      await this.analysisRunQueue.add("analysis-run", {
        analysisRunId: analysisRun.analysis_run_id
      });

      this.log("V6 analysis run persisted; provider execution is not implemented yet", {
        domain: validation.normalizedDomain,
        ipAddress,
        analysisRunId: analysisRun.analysis_run_id,
        runItemCount: runItems.length
      });

      return {
        statusCode: 202,
        body: {
          status: analysisRun.status,
          code: "V6_ANALYSIS_RUN_QUEUED",
          message: "V6 analysis run queued; provider execution not implemented yet.",
          analysisRunId: analysisRun.analysis_run_id,
          domain: validation.normalizedDomain,
          runItemCount: runItems.length,
          queueStatus: "enqueued",
          runItems,
          providerExecutionStarted: false
        }
      };
    } catch (error) {
      if (error instanceof AnalysisRequestValidationError) {
        return apiError(400, error.message, error.details);
      }

      throw error;
    }
  }

  private getRunItemPathIds(paths: ValidatedAnalysisPath[]): number[] {
    const pathIds = paths.flatMap((path) => {
      if (path.pathType === "product") {
        return path.pathIds;
      }

      return [path.pathId];
    });

    return [...new Set(pathIds)];
  }
}
