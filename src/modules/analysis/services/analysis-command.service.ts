import { BaseService } from "../../../services/base.service.js";
import type { AnalysisRequest } from "../types/v6-analysis-request.js";

export class AnalysisCommandService extends BaseService {
  constructor() {
    super();
  }

  async enqueueAnalysis(request: AnalysisRequest, ipAddress: string) {
    const domain = this.normalizeDomain(request.domain);
    this.log("V6 analysis command is not implemented yet", {
      domain,
      ipAddress,
      categoryCount: request.categories?.length ?? 0
    });

    // TODO: V6_REBUILD_REQUIRED persist a hierarchy-aware analysis run and enqueue a V6 queue payload.
    return {
      statusCode: 501,
      body: {
        status: "not_implemented",
        code: "V6_ANALYSIS_REBUILD_REQUIRED",
        message: "V6 hierarchy-aware analysis is not implemented yet.",
        accepted_contract: "AnalysisRequest",
        domain,
        selection: {
          categories: request.categories ?? []
        }
      }
    };
  }

  private normalizeDomain(input: string) {
    const trimmed = input.trim().toLowerCase();
    const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
    const withoutPath = withoutProtocol.split("/")[0] ?? "";
    const withoutPort = withoutPath.split(":")[0] ?? "";
    return withoutPort.replace(/^www\./, "");
  }
}
