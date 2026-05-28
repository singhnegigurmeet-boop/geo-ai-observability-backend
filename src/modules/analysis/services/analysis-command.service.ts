import { BaseService } from "../../../services/base.service.js";
import { apiError } from "../../../utils/api-response.js";
import type { AnalysisRequest } from "../types/v6-analysis-request.js";
import {
  AnalysisRequestValidationError,
  type AnalysisRequestValidationService
} from "./analysis-request-validation.service.js";

export class AnalysisCommandService extends BaseService {
  constructor(private readonly validationService: AnalysisRequestValidationService) {
    super();
  }

  async enqueueAnalysis(request: AnalysisRequest, ipAddress: string) {
    try {
      const validation = await this.validationService.validateRequest(request);
      this.log("V6 analysis request validated; execution is not implemented yet", {
        domain: validation.normalizedDomain,
        ipAddress,
        pathCount: validation.paths.length,
        useContextSelectionRequired: validation.useContextSelectionRequired
      });

      return {
        statusCode: 501,
        body: {
          status: "not_implemented",
          code: "V6_ANALYSIS_EXECUTION_NOT_IMPLEMENTED",
          message: "V6 hierarchy-aware analysis validation succeeded, but execution is not implemented yet.",
          accepted_contract: "AnalysisRequest",
          domain: validation.normalizedDomain,
          validation
        }
      };
    } catch (error) {
      if (error instanceof AnalysisRequestValidationError) {
        return apiError(400, error.message, error.details);
      }

      throw error;
    }
  }
}
