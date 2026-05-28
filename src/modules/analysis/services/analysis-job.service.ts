import type { AnalysisJobData } from "../../../types/queue.types.js";

export class AnalysisJobService {
  async processAnalysisJob(job: AnalysisJobData) {
    console.warn("V6 analysis worker received a placeholder job; no provider analysis was executed.", {
      analysisRunId: job.analysisRunId ?? null,
      domain: job.request.domain,
      categoryCount: job.request.categories?.length ?? 0
    });

    // TODO: V6_REBUILD_REQUIRED implement hierarchy-aware provider orchestration and backend scoring.
    return null;
  }
}

