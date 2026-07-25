import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { OutboxEventWriterRepository } from "../outbox/outbox-event-writer.repository.js";
import { ProviderJobRepository } from "../providers/provider-job.repository.js";
import { selectProviderModel } from "../providers/provider-model.policy.js";
import {
  PromptExecutionRepository,
  type PromptExecutionState
} from "./prompt-execution.repository.js";
import { PromptRendererService } from "./prompt-renderer.service.js";
import type { PromptJobCreatedPayload } from "./prompt-worker.messages.js";

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
    private readonly renderer = new PromptRendererService()
  ) {}

  async execute(
    payload: PromptJobCreatedPayload
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
      const selection = selectProviderModel({
        actorType,
        requestedProvider: state.requested_provider,
        requestedModel: state.requested_model
      });
      const providerJob = await new ProviderJobRepository(
        client
      ).createOrReuse({
        promptJobId: state.prompt_job_id,
        provider: selection.provider,
        model: selection.model,
        requestPayload: {
          promptJobId: state.prompt_job_id
        }
      });
      await new OutboxEventWriterRepository(client).createOrReuse({
        eventKey: `provider_job.created:${providerJob.provider_job_id}`,
        eventType: "provider_job.created",
        eventVersion: 1,
        aggregateType: "provider_job",
        aggregateId: providerJob.provider_job_id,
        headers: { queueName: selection.queueName },
        payload: {
          providerJobId: providerJob.provider_job_id,
          promptJobId: state.prompt_job_id,
          provider: selection.provider,
          model: selection.model
        }
      });
      return {
        outcome: "enqueued",
        providerJobId: providerJob.provider_job_id
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
    payload.llmRunId !== state.llm_run_id ||
    payload.analysisRunItemId !== state.analysis_run_item_id ||
    payload.analysisRunId !== state.analysis_run_id ||
    payload.entityPathId !== state.entity_path_id ||
    payload.startingEntityPathId !== state.starting_entity_path_id ||
    payload.promptType !== state.prompt_type ||
    payload.promptVersion !== state.prompt_version ||
    payload.actorType !== actorType ||
    payload.userId !== state.user_id ||
    payload.workspaceId !== state.workspace_id ||
    payload.anonymousSessionId !== state.anonymous_session_id
  ) {
    throw new PromptExecutionError(
      "PROMPT_JOB_MESSAGE_MISMATCH",
      "Message identifiers or ownership do not match authoritative state"
    );
  }
}
