import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { EntityPathRepository } from "../hierarchy/entity-path.repository.js";
import { OutboxEventWriterRepository } from "../outbox/outbox-event-writer.repository.js";
import type {
  AnalysisRunRow,
  EntityPathRow
} from "../types/database.types.js";
import { AnalysisRunExpansionRepository } from "./analysis-run-expansion.repository.js";
import { AnalysisRunItemRepository } from "./analysis-run-item.repository.js";
import type { AnalysisRunCreatedPayload } from "./analysis-run-worker.messages.js";

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
      if (run.status !== "queued") {
        return { outcome: "noop", itemCount: 0 };
      }
      assertPayloadMatchesRun(payload, run);

      const startingPath = await expansion.findActiveStartingPath(
        run.starting_entity_path_id
      );
      if (!startingPath) {
        throw new PermanentAnalysisRunError(
          "STARTING_ENTITY_PATH_INVALID",
          "Starting entity path is inactive or no longer has an active hierarchy chain"
        );
      }

      const breadth = run.user_id && run.workspace_id ? 5 : 3;
      const selections = await selectChildren(expansion, startingPath, breadth);
      if (selections.length === 0) {
        await expansion.markNoExpansionChildren(
          run.analysis_run_id,
          `No active ${nextHierarchyLevel(startingPath.path_type)} relationships exist for the starting path`
        );
        return { outcome: "empty", itemCount: 0 };
      }

      const paths = new EntityPathRepository(client);
      const items = new AnalysisRunItemRepository(client);
      const outbox = new OutboxEventWriterRepository(client);
      const actorType = run.user_id && run.workspace_id ? "user" : "anonymous";

      for (const [ordinal, selection] of selections.entries()) {
        const path =
          startingPath.path_type === "use_context"
            ? startingPath
            : await paths.findOrCreate(selection);
        const item = await items.createOrReuse({
          analysisRunId: run.analysis_run_id,
          entityPathId: path.entity_path_id,
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
            analysisRunItemId: item.analysis_run_item_id,
            analysisRunId: run.analysis_run_id,
            entityPathId: path.entity_path_id,
            startingEntityPathId: run.starting_entity_path_id,
            actorType,
            userId: run.user_id,
            workspaceId: run.workspace_id,
            anonymousSessionId: run.anonymous_session_id
          }
        });
      }

      await expansion.markProcessing(run.analysis_run_id);
      return { outcome: "expanded", itemCount: selections.length };
    });
  }
}

async function selectChildren(
  repository: AnalysisRunExpansionRepository,
  path: EntityPathRow,
  breadth: number
) {
  switch (path.path_type) {
    case "domain":
      return repository.listActiveCategoryChildren(path.domain_id, breadth);
    case "category":
      return repository.listActiveBrandChildren(path, breadth);
    case "brand":
      return repository.listActiveProductChildren(path, breadth);
    case "product":
      return repository.listActiveUseContextChildren(path, breadth);
    case "use_context":
      return [
        {
          domainId: path.domain_id,
          categoryId: path.category_id,
          brandId: path.brand_id,
          productId: path.product_id,
          useContextId: path.use_context_id,
          pathType: path.path_type
        }
      ];
  }
}

function assertPayloadMatchesRun(
  payload: AnalysisRunCreatedPayload,
  run: AnalysisRunRow
) {
  const actorType = run.user_id && run.workspace_id ? "user" : "anonymous";
  if (
    payload.startingEntityPathId !== run.starting_entity_path_id ||
    payload.actorType !== actorType ||
    payload.userId !== run.user_id ||
    payload.workspaceId !== run.workspace_id ||
    payload.anonymousSessionId !== run.anonymous_session_id
  ) {
    throw new PermanentAnalysisRunError(
      "ANALYSIS_RUN_MESSAGE_MISMATCH",
      "Message payload does not match authoritative analysis run state"
    );
  }
}

function nextHierarchyLevel(pathType: EntityPathRow["path_type"]) {
  switch (pathType) {
    case "domain":
      return "domain-category";
    case "category":
      return "category-brand";
    case "brand":
      return "brand-product";
    case "product":
      return "product-use-context";
    case "use_context":
      return "deeper";
  }
}
