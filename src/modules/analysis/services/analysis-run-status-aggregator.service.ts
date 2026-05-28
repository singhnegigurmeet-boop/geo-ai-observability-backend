import type { AnalysisRunItemsRepository } from "../repositories/analysis-run-items.repository.js";
import type { AnalysisRunsRepository } from "../repositories/analysis-runs.repository.js";
import type { AnalysisRunStatus, AnalysisRunItemStatus } from "../../../types/database.types.js";

const ACTIVE_ITEM_STATUSES = new Set<AnalysisRunItemStatus>(["queued", "processing"]);

export class AnalysisRunStatusAggregatorService {
  constructor(
    private readonly analysisRunsRepository: AnalysisRunsRepository,
    private readonly analysisRunItemsRepository: AnalysisRunItemsRepository
  ) {}

  async aggregateRunStatus(analysisRunId: number): Promise<AnalysisRunStatus> {
    const items = await this.analysisRunItemsRepository.listRunItems(analysisRunId);
    const nextStatus = this.resolveRunStatus(items.map((item) => item.status));

    await this.analysisRunsRepository.updateAnalysisRunStatus(analysisRunId, nextStatus);

    return nextStatus;
  }

  resolveRunStatus(statuses: AnalysisRunItemStatus[]): AnalysisRunStatus {
    if (statuses.length === 0) {
      return "failed";
    }

    if (statuses.some((status) => ACTIVE_ITEM_STATUSES.has(status))) {
      return "processing";
    }

    const failedCount = statuses.filter((status) => status === "failed").length;
    const successLikeCount = statuses.filter((status) => status === "completed" || status === "skipped").length;

    if (statuses.every((status) => status === "cancelled")) {
      return "cancelled";
    }

    if (failedCount === statuses.length) {
      return "failed";
    }

    if (failedCount > 0) {
      return "partial_success";
    }

    // During the V6 queue scaffold phase, skipped means the expected provider-execution placeholder.
    if (successLikeCount === statuses.length) {
      return "completed";
    }

    return "processing";
  }
}
