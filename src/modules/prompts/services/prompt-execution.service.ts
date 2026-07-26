import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { AnalysisRunProviderModelRepository } from "../../providers/repositories/analysis-run-provider-model.repository.js";
import { ProviderJobRepository } from "../../providers/repositories/provider-job.repository.js";
import { validateFrozenProviderModel } from "../../providers/policies/provider-model.policy.js";
import {
  PromptExecutionRepository
} from "../repositories/prompt-execution.repository.js";
import { PromptRendererService } from "./prompt-renderer.service.js";
import type { PromptJobCreatedPayload } from "../messages/prompt-worker.messages.js";
import type { PromptType } from "../../../common/types/database.types.js";
import { createHash } from "node:crypto";
import { EntityPathContextRepository } from "../repositories/entity-path-context.repository.js";
import { providerModelProfile } from "../../providers/registry/provider-model.registry.js";
import { isDeepStrictEqual } from "node:util";

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
      const entityPathContext = await new EntityPathContextRepository(
        client
      ).find(state.entity_path_id, state.starting_entity_path_id);
      if (
        !entityPathContext ||
        !isDeepStrictEqual(
          state.input_payload.entityPathContext,
          entityPathContext
        )
      ) {
        throw new PromptExecutionError(
          "ENTITY_PATH_CONTEXT_CHANGED",
          "Frozen prompt context does not match the authoritative hierarchy"
        );
      }
      const promptText = this.renderer.render({
        promptType: state.prompt_type,
        promptDepth: state.prompt_depth,
        businessPromptVersion: state.business_prompt_version,
        responseContractVersion: state.response_contract_version,
        entityPathContext
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
        await new AnalysisRunProviderModelRepository(client).list(
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
          {
            provider: pair.provider,
            model: pair.model,
            modelProfileVersion: pair.model_profile_version
          },
          this.realProvidersEnabled,
          state.prompt_depth
        );
        const profile = providerModelProfile(
          selection.provider,
          selection.model
        );
        if (!profile) {
          throw new PromptExecutionError(
            "FROZEN_MODEL_PROFILE_MISSING",
            "Frozen provider model is no longer represented in the registry"
          );
        }
        const requestPayload = {
          promptJobId: state.prompt_job_id,
          promptType: state.prompt_type,
          promptDepth: state.prompt_depth,
          businessPromptVersion: state.business_prompt_version,
          responseContractVersion: state.response_contract_version,
          promptText,
          entityPathContext,
          temperature: profile.defaultRequestSettings.temperature,
          maximumOutputTokens:
            profile.maximumOutputTokens[state.prompt_depth]
        };
        const requestHash = createHash("sha256")
          .update(JSON.stringify(requestPayload))
          .digest("hex");
        const providerJob = await jobs.createOrReuse({
          promptJobId: state.prompt_job_id,
          provider: selection.provider,
          model: selection.model,
          responseContractVersion: state.response_contract_version,
          providerInstructionProfile:
            selection.providerInstructionProfile,
          modelProfileVersion: selection.modelProfileVersion,
          structuredOutputMode:
            selection.preferredStructuredOutputMode,
          requestHash,
          requestPayload
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
