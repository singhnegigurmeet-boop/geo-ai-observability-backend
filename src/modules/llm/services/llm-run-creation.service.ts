import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { AnalysisRunItemRepository } from "../../analysis/repositories/analysis-run-item.repository.js";
import type { AnalysisRunItemCreatedPayload } from "../../analysis/messages/analysis-run-item-worker.messages.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { LlmRunRepository } from "../repositories/llm-run.repository.js";
import type { LlmRunCreationResult } from "../types/llm-run.types.js";

type LlmRunDatabase = DatabaseExecutor & TransactionPool;

export class LlmRunCreationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LlmRunCreationError";
  }
}

export class LlmRunCreationService {
  constructor(private readonly database: LlmRunDatabase) {}

  async create(
    payload: AnalysisRunItemCreatedPayload
  ): Promise<LlmRunCreationResult> {
    return inTransaction(this.database, async (client) => {
      const items = new AnalysisRunItemRepository(client);
      const item = await items.findForUpdate(payload.analysisRunItemId);
      if (!item) {
        throw new LlmRunCreationError(
          "ANALYSIS_RUN_ITEM_NOT_FOUND",
          `Analysis run item ${payload.analysisRunItemId} does not exist`
        );
      }
      if (item.status !== "queued") {
        return { outcome: "noop", llmRunId: null };
      }

      const llmRuns = new LlmRunRepository(client);
      const parent = await llmRuns.findParentRun(item.analysis_run_id);
      if (!parent) {
        throw new LlmRunCreationError(
          "PARENT_ANALYSIS_RUN_NOT_FOUND",
          "Parent analysis run does not exist"
        );
      }
      const path = await llmRuns.findActiveEntityPath(item.entity_path_id);
      if (!path) {
        throw new LlmRunCreationError(
          "ITEM_ENTITY_PATH_NOT_FOUND",
          "Analysis run item entity path does not exist or is inactive"
        );
      }
      const llmRun = await llmRuns.createOrReuseForItem(
        item.analysis_run_item_id
      );
      await new OutboxEventWriterRepository(client).createOrReuse({
        eventKey: `llm_run.created:${llmRun.llm_run_id}`,
        eventType: "llm_run.created",
        eventVersion: 1,
        aggregateType: "llm_run",
        aggregateId: llmRun.llm_run_id,
        headers: { queueName: "llm_run_queue" },
        payload: {
          llmRunId: llmRun.llm_run_id
        }
      });

      const transitioned = await items.markProcessing(
        item.analysis_run_item_id
      );
      if (!transitioned) {
        throw new LlmRunCreationError(
          "ANALYSIS_RUN_ITEM_TRANSITION_FAILED",
          "Queued analysis run item could not transition to processing"
        );
      }
      return { outcome: "created", llmRunId: llmRun.llm_run_id };
    });
  }
}
