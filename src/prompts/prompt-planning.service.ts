import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import type { LlmRunCreatedPayload } from "../llm/llm-run-worker.messages.js";
import { LlmRunRepository } from "../llm/llm-run.repository.js";
import { OutboxEventWriterRepository } from "../outbox/outbox-event-writer.repository.js";
import type {
  AnalysisRunItemRow,
  AnalysisRunRow,
  LlmRunRow
} from "../types/database.types.js";
import { PromptJobRepository } from "./prompt-job.repository.js";
import { promptPlanFor } from "./prompt-plan.policy.js";
import type { PromptPlanningResult } from "./prompt.types.js";

type PromptPlanningDatabase = DatabaseExecutor & TransactionPool;

export class PromptPlanningError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PromptPlanningError";
  }
}

export class PromptPlanningService {
  constructor(private readonly database: PromptPlanningDatabase) {}

  async plan(payload: LlmRunCreatedPayload): Promise<PromptPlanningResult> {
    return inTransaction(this.database, async (client) => {
      const llmRuns = new LlmRunRepository(client);
      const llmRun = await llmRuns.findForUpdate(payload.llmRunId);
      if (!llmRun) {
        throw new PromptPlanningError(
          "LLM_RUN_NOT_FOUND",
          `LLM run ${payload.llmRunId} does not exist`
        );
      }
      if (llmRun.status !== "queued") {
        return { outcome: "noop", promptJobCount: 0 };
      }

      const item = await llmRuns.findParentItem(
        llmRun.analysis_run_item_id
      );
      if (!item) {
        throw new PromptPlanningError(
          "ANALYSIS_RUN_ITEM_NOT_FOUND",
          "Parent analysis run item does not exist"
        );
      }
      const parent = await llmRuns.findParentRun(item.analysis_run_id);
      if (!parent) {
        throw new PromptPlanningError(
          "ANALYSIS_RUN_NOT_FOUND",
          "Parent analysis run does not exist"
        );
      }
      const path = await llmRuns.findActiveEntityPath(item.entity_path_id);
      if (!path) {
        throw new PromptPlanningError(
          "ENTITY_PATH_NOT_FOUND",
          "Analysis run item entity path does not exist or is inactive"
        );
      }
      assertPayloadMatchesState(payload, llmRun, item, parent);

      const actorType =
        parent.user_id && parent.workspace_id ? "user" : "anonymous";
      const plan = promptPlanFor(actorType);
      const prompts = new PromptJobRepository(client);
      const outbox = new OutboxEventWriterRepository(client);
      for (const entry of plan) {
        const promptJob = await prompts.createOrReuse({
          llmRunId: llmRun.llm_run_id,
          promptType: entry.promptType,
          promptVersion: entry.promptVersion
        });
        await outbox.createOrReuse({
          eventKey: `prompt_job.created:${promptJob.prompt_job_id}`,
          eventType: "prompt_job.created",
          eventVersion: 1,
          aggregateType: "prompt_job",
          aggregateId: promptJob.prompt_job_id,
          headers: { queueName: entry.queueName },
          payload: {
            promptJobId: promptJob.prompt_job_id,
            llmRunId: llmRun.llm_run_id,
            analysisRunItemId: item.analysis_run_item_id,
            analysisRunId: parent.analysis_run_id,
            entityPathId: path.entity_path_id,
            startingEntityPathId: parent.starting_entity_path_id,
            promptType: entry.promptType,
            promptVersion: entry.promptVersion,
            actorType,
            userId: parent.user_id,
            workspaceId: parent.workspace_id,
            anonymousSessionId: parent.anonymous_session_id
          }
        });
      }

      const transitioned = await llmRuns.markProcessing(llmRun.llm_run_id);
      if (!transitioned) {
        throw new PromptPlanningError(
          "LLM_RUN_TRANSITION_FAILED",
          "Queued LLM run could not transition to processing"
        );
      }
      return { outcome: "planned", promptJobCount: plan.length };
    });
  }
}

function assertPayloadMatchesState(
  payload: LlmRunCreatedPayload,
  llmRun: LlmRunRow,
  item: AnalysisRunItemRow,
  parent: AnalysisRunRow
) {
  const actorType =
    parent.user_id && parent.workspace_id ? "user" : "anonymous";
  if (payload.analysisRunItemId !== llmRun.analysis_run_item_id) {
    throw new PromptPlanningError(
      "ANALYSIS_RUN_ITEM_ID_MISMATCH",
      "Message analysisRunItemId does not match the LLM run"
    );
  }
  if (payload.analysisRunId !== item.analysis_run_id) {
    throw new PromptPlanningError(
      "ANALYSIS_RUN_ID_MISMATCH",
      "Message analysisRunId does not match the parent item"
    );
  }
  if (payload.entityPathId !== item.entity_path_id) {
    throw new PromptPlanningError(
      "ENTITY_PATH_ID_MISMATCH",
      "Message entityPathId does not match the parent item"
    );
  }
  if (
    payload.startingEntityPathId !== parent.starting_entity_path_id ||
    payload.actorType !== actorType ||
    payload.userId !== parent.user_id ||
    payload.workspaceId !== parent.workspace_id ||
    payload.anonymousSessionId !== parent.anonymous_session_id
  ) {
    throw new PromptPlanningError(
      "LLM_RUN_MESSAGE_MISMATCH",
      "Message ownership or starting path does not match authoritative state"
    );
  }
}
