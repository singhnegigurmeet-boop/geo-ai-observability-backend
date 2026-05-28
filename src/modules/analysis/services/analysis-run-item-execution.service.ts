import type { AnalysisRunItemJobPayload } from "../../../types/queue.types.js";
import type { AnalysisRunItemsRepository } from "../repositories/analysis-run-items.repository.js";
import type { AnalysisRunStatusAggregatorService } from "./analysis-run-status-aggregator.service.js";

const PROVIDER_EXECUTION_NOT_IMPLEMENTED_MESSAGE = "Provider execution not implemented yet";

export class AnalysisRunItemExecutionService {
  constructor(
    private readonly analysisRunItemsRepository: AnalysisRunItemsRepository,
    private readonly statusAggregatorService: AnalysisRunStatusAggregatorService
  ) {}

  async processAnalysisRunItem(payload: AnalysisRunItemJobPayload) {
    try {
      const runItem = await this.analysisRunItemsRepository.getRunItemWithPathById(payload.runItemId);

      if (!runItem) {
        throw new Error(`Analysis run item not found: ${payload.runItemId}`);
      }

      if (runItem.analysis_run_id !== payload.analysisRunId) {
        throw new Error(
          `Analysis run item ${payload.runItemId} does not belong to analysis run ${payload.analysisRunId}`
        );
      }

      await this.analysisRunItemsRepository.updateRunItemStatus(payload.runItemId, "processing");

      console.warn(PROVIDER_EXECUTION_NOT_IMPLEMENTED_MESSAGE, {
        analysisRunId: payload.analysisRunId,
        runItemId: payload.runItemId,
        pathId: runItem.path_id,
        pathType: runItem.path_type
      });

      await this.analysisRunItemsRepository.updateRunItemStatus(payload.runItemId, "skipped");
      const analysisRunStatus = await this.statusAggregatorService.aggregateRunStatus(payload.analysisRunId);

      return {
        status: "skipped" as const,
        reason: PROVIDER_EXECUTION_NOT_IMPLEMENTED_MESSAGE,
        analysisRunStatus
      };
    } catch (error) {
      await this.analysisRunItemsRepository.updateRunItemStatus(payload.runItemId, "failed");
      await this.statusAggregatorService.aggregateRunStatus(payload.analysisRunId);
      throw error;
    }
  }
}
