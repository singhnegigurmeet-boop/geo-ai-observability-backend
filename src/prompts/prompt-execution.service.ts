import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { OutboxEventWriterRepository } from "../outbox/outbox-event-writer.repository.js";
import { AnalysisRunProviderModelRepository } from "../providers/analysis-run-provider-model.repository.js";
import { ProviderJobRepository } from "../providers/provider-job.repository.js";
import { validateFrozenProviderModel } from "../providers/provider-model.policy.js";
import {
  PromptExecutionRepository,
  type PromptExecutionState
} from "./prompt-execution.repository.js";
import { PromptRendererService } from "./prompt-renderer.service.js";
import type { PromptJobCreatedPayload } from "./prompt-worker.messages.js";
import type { PromptType } from "../types/database.types.js";

type PromptExecutionDatabase = DatabaseExecutor & TransactionPool;

export type PromptExecutionResult =
  | { outcome: "enqueued"; providerJobId: string }
  | { outcome: "noop"; providerJobId: null };

export class PromptExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PromptExecutionError";
  }
}

export class PromptExecutionService {
  constructor(
    private readonly database: PromptExecutionDatabase,
    private readonly renderer = new PromptRendererService(),
    private readonly realProvidersEnabled = false
  ) {}

  async execute(
    payload: PromptJobCreatedPayload,
    expectedPromptType?: PromptType
  ): Promise<PromptExecutionResult> {
    return inTransaction(this.database, async (client) => {
      const prompts = new PromptExecutionRepository(client);
      const state = await prompts.findForUpdate(payload.promptJobId);
      if (!state) {
        throw new PromptExecutionError(
          "PROMPT_JOB_NOT_FOUND",
          `Prompt job ${payload.promptJobId} or its active context does not exist`
        );
      }
      if (state.prompt_status !== "pending") {
        return { outcome: "noop", providerJobId: null };
      }
      if (expectedPromptType && state.prompt_type !== expectedPromptType) {
        throw new PromptExecutionError(
          "PROMPT_QUEUE_MISMATCH",
          `Prompt job does not belong on the ${expectedPromptType} queue`
        );
      }
      if (state.prompt_text !== null) {
        throw new PromptExecutionError(
          "UNEXPECTED_RENDERED_PROMPT",
          "Pending prompt job already contains rendered text"
        );
      }
      assertPayloadMatchesState(payload, state);

      const actorType =
        state.user_id && state.workspace_id ? "user" : "anonymous";
      const promptText = this.renderer.render({
        promptType: state.prompt_type,
        promptVersion: state.prompt_version as "v1" | "v1_light",
        actorType,
        normalizedDomain: state.normalized_domain,
        pathType: state.path_type,
        categoryName: state.category_name,
        brandName: state.brand_name,
        productName: state.product_name,
        useContextName: state.use_context_name
      });
      if (!promptText.trim()) {
        throw new PromptExecutionError(
          "BLANK_RENDERED_PROMPT",
          "Rendered prompt text must be nonblank"
        );
      }

      const transitioned = await prompts.markRenderedProcessing(
        state.prompt_job_id,
        promptText
      );
      if (!transitioned) {
        throw new PromptExecutionError(
          "PROMPT_JOB_TRANSITION_FAILED",
          "Pending prompt job could not transition to processing"
        );
      }
      const providerModels =
        await new AnalysisRunProviderModelRepository(client).listPairs(
          state.analysis_run_id
        );
      if (providerModels.length === 0) {
        throw new PromptExecutionError(
          "PROVIDER_SET_MISSING",
          "Analysis run has no frozen provider/model set"
        );
      }
      const jobs = new ProviderJobRepository(client);
      const outbox = new OutboxEventWriterRepository(client);
      let firstProviderJobId: string | null = null;
      for (const pair of providerModels) {
        const selection = validateFrozenProviderModel(
          pair,
          this.realProvidersEnabled
        );
        const providerJob = await jobs.createOrReuse({
          promptJobId: state.prompt_job_id,
          provider: selection.provider,
          model: selection.model,
          requestPayload: { promptJobId: state.prompt_job_id }
        });
        firstProviderJobId ??= providerJob.provider_job_id;
        await outbox.createOrReuse({
          eventKey: `provider_job.created:${providerJob.provider_job_id}`,
          eventType: "provider_job.created",
          eventVersion: 1,
          aggregateType: "provider_job",
          aggregateId: providerJob.provider_job_id,
          headers: { queueName: selection.queueName },
          payload: { providerJobId: providerJob.provider_job_id }
        });
      }
      return {
        outcome: "enqueued",
        providerJobId: firstProviderJobId as string
      };
    });
  }
}

function assertPayloadMatchesState(
  payload: PromptJobCreatedPayload,
  state: PromptExecutionState
) {
  const actorType =
    state.user_id && state.workspace_id ? "user" : "anonymous";
  if (
    (payload.llmRunId !== undefined &&
      payload.llmRunId !== state.llm_run_id) ||
    (payload.analysisRunItemId !== undefined &&
      payload.analysisRunItemId !== state.analysis_run_item_id) ||
    (payload.analysisRunId !== undefined &&
      payload.analysisRunId !== state.analysis_run_id) ||
    (payload.entityPathId !== undefined &&
      payload.entityPathId !== state.entity_path_id) ||
    (payload.startingEntityPathId !== undefined &&
      payload.startingEntityPathId !== state.starting_entity_path_id) ||
    (payload.promptType !== undefined &&
      payload.promptType !== state.prompt_type) ||
    (payload.promptVersion !== undefined &&
      payload.promptVersion !== state.prompt_version) ||
    (payload.actorType !== undefined && payload.actorType !== actorType) ||
    (payload.userId !== undefined && payload.userId !== state.user_id) ||
    (payload.workspaceId !== undefined &&
      payload.workspaceId !== state.workspace_id) ||
    (payload.anonymousSessionId !== undefined &&
      payload.anonymousSessionId !== state.anonymous_session_id)
  ) {
    throw new PromptExecutionError(
      "PROMPT_JOB_MESSAGE_MISMATCH",
      "Message identifiers or ownership do not match authoritative state"
    );
  }
}
