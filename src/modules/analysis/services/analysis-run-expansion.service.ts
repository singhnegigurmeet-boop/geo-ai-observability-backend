import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { EntityPathRepository } from "../../hierarchy/repositories/entity-path.repository.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { AnalysisRunExpansionRepository } from "../repositories/analysis-run-expansion.repository.js";
import { AnalysisRunItemRepository } from "../repositories/analysis-run-item.repository.js";
import type { AnalysisRunCreatedPayload } from "../messages/analysis-run-worker.messages.js";

type ExpansionDatabase = DatabaseExecutor & TransactionPool;

export type AnalysisRunExpansionResult =
  | { outcome: "expanded"; itemCount: number }
  | { outcome: "empty"; itemCount: 0 }
  | { outcome: "noop"; itemCount: 0 };

export class PermanentAnalysisRunError extends Error {
  readonly permanent = true;

  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PermanentAnalysisRunError";
  }
}

export class AnalysisRunExpansionService {
  constructor(private readonly database: ExpansionDatabase) {}

  async expand(
    payload: AnalysisRunCreatedPayload
  ): Promise<AnalysisRunExpansionResult> {
    return inTransaction(this.database, async (client) => {
      const expansion = new AnalysisRunExpansionRepository(client);
      const run = await expansion.findRunForUpdate(payload.analysisRunId);
      if (!run) {
        throw new PermanentAnalysisRunError(
          "ANALYSIS_RUN_NOT_FOUND",
          `Analysis run ${payload.analysisRunId} does not exist`
        );
      }
      if (run.status !== "queued" && run.status !== "processing") {
        return { outcome: "noop", itemCount: 0 };
      }
      if (await expansion.hasItems(run.analysis_run_id)) {
        return { outcome: "noop", itemCount: 0 };
      }
      const startingPath = await new EntityPathRepository(
        client
      ).findActiveValidated(
        run.starting_entity_path_id
      );
      if (!startingPath) {
        throw new PermanentAnalysisRunError(
          "STARTING_ENTITY_PATH_INVALID",
          "Starting entity path is inactive or no longer has an active hierarchy chain"
        );
      }

      const selections = [startingPath];
      const items = new AnalysisRunItemRepository(client);
      const outbox = new OutboxEventWriterRepository(client);
      for (const [ordinal, selection] of selections.entries()) {
        const item = await items.createOrReuse({
          analysisRunId: run.analysis_run_id,
          entityPathId: selection.entity_path_id,
          ordinal
        });
        await outbox.createOrReuse({
          eventKey:
            `analysis_run_item.created:${item.analysis_run_item_id}`,
          eventType: "analysis_run_item.created",
          eventVersion: 1,
          aggregateType: "analysis_run_item",
          aggregateId: item.analysis_run_item_id,
          headers: { queueName: "analysis_run_item_queue" },
          payload: {
            analysisRunItemId: item.analysis_run_item_id
          }
        });
      }

      await expansion.markProcessing(run.analysis_run_id);
      return { outcome: "expanded", itemCount: selections.length };
    });
  }
}
