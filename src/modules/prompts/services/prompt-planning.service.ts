import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import type { LlmRunCreatedPayload } from "../../llm/messages/llm-run-worker.messages.js";
import { LlmRunRepository } from "../../llm/repositories/llm-run.repository.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { PromptJobRepository } from "../repositories/prompt-job.repository.js";
import { EntityPathContextRepository } from "../repositories/entity-path-context.repository.js";
import { promptPlanFor } from "../policies/prompt-plan.policy.js";
import type { PromptPlanningResult } from "../types/prompt.types.js";

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
      const plan = promptPlanFor({
        pathLevel: path.path_type,
        promptDepth: parent.prompt_depth
      });
      const entityPathContext = await new EntityPathContextRepository(
        client
      ).find(path.entity_path_id, parent.starting_entity_path_id);
      if (!entityPathContext) {
        throw new PromptPlanningError(
          "ENTITY_PATH_CONTEXT_INVALID",
          "The authoritative entity path context is missing or inactive"
        );
      }
      const prompts = new PromptJobRepository(client);
      const outbox = new OutboxEventWriterRepository(client);
      for (const entry of plan) {
        const promptJob = await prompts.createOrReuse({
          llmRunId: llmRun.llm_run_id,
          promptType: entry.promptType,
          promptDepth: entry.promptDepth,
          businessPromptVersion: entry.businessPromptVersion,
          responseContractVersion: entry.responseContractVersion,
          entityPathContext
        });
        await outbox.createOrReuse({
          eventKey: `prompt_job.created:${promptJob.prompt_job_id}`,
          eventType: "prompt_job.created",
          eventVersion: 1,
          aggregateType: "prompt_job",
          aggregateId: promptJob.prompt_job_id,
          headers: { queueName: entry.queueName },
          payload: {
            promptJobId: promptJob.prompt_job_id
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
