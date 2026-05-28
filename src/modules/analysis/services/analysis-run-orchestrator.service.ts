import type { Queue } from "bullmq";
import type { AnalysisRunItemJobPayload, AnalysisRunJobPayload } from "../../../types/queue.types.js";
import type { AnalysisRunItemsRepository } from "../repositories/analysis-run-items.repository.js";
import type { AnalysisRunsRepository } from "../repositories/analysis-runs.repository.js";
import type { AnalysisRunStatusAggregatorService } from "./analysis-run-status-aggregator.service.js";

export class AnalysisRunOrchestratorService {
  constructor(
    private readonly analysisRunsRepository: AnalysisRunsRepository,
    private readonly analysisRunItemsRepository: AnalysisRunItemsRepository,
    private readonly analysisRunItemQueue: Pick<Queue<AnalysisRunItemJobPayload>, "add">,
    private readonly statusAggregatorService: AnalysisRunStatusAggregatorService
  ) {}

  async processAnalysisRun(payload: AnalysisRunJobPayload) {
    try {
      const analysisRun = await this.analysisRunsRepository.getAnalysisRunById(payload.analysisRunId);

      if (!analysisRun) {
        throw new Error(`Analysis run not found: ${payload.analysisRunId}`);
      }

      const runItems = await this.analysisRunItemsRepository.listRunItems(payload.analysisRunId);

      if (runItems.length === 0) {
        await this.analysisRunsRepository.updateAnalysisRunStatus(payload.analysisRunId, "failed");
        return {
          enqueuedRunItemCount: 0,
          status: "failed" as const
        };
      }

      await this.analysisRunsRepository.updateAnalysisRunStatus(payload.analysisRunId, "processing");

      const queuedItems = runItems.filter((item) => item.status === "queued");

      for (const item of queuedItems) {
        await this.analysisRunItemQueue.add("analysis-run-item", {
          analysisRunId: payload.analysisRunId,
          runItemId: item.run_item_id
        });
      }

      if (queuedItems.length === 0) {
        const status = await this.statusAggregatorService.aggregateRunStatus(payload.analysisRunId);
        return {
          enqueuedRunItemCount: 0,
          status
        };
      }

      return {
        enqueuedRunItemCount: queuedItems.length,
        status: "processing" as const
      };
    } catch (error) {
      await this.analysisRunsRepository.updateAnalysisRunStatus(payload.analysisRunId, "failed");
      throw error;
    }
  }
}
