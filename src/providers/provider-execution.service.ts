import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { BudgetCheckService } from "../budgets/budget-check.service.js";
import { BudgetRepository } from "../budgets/budget.repository.js";
import { estimateCostMicros } from "../budgets/provider-pricing.policy.js";
import { OutboxEventWriterRepository } from "../outbox/outbox-event-writer.repository.js";
import { ProviderAdapterRegistry } from "./provider-adapter.registry.js";
import { ProviderExecutionError } from "./provider-execution.error.js";
import { ProviderExecutionRepository } from "./provider-execution.repository.js";
import type { ProviderJobCreatedPayload } from "./provider-worker.messages.js";

type ProviderDatabase = DatabaseExecutor & TransactionPool;

export type ProviderExecutionOutcome =
  | { outcome: "completed"; providerResultId: string }
  | {
      outcome: "paused_budget";
      providerResultId: null;
      budgetPolicyId: string | null;
    }
  | { outcome: "noop"; providerResultId: null };

export class ProviderExecutionService {
  constructor(
    private readonly database: ProviderDatabase,
    private readonly adapters: ProviderAdapterRegistry,
    private readonly timeoutMs: number
  ) {}

  async execute(
    payload: ProviderJobCreatedPayload
  ): Promise<ProviderExecutionOutcome> {
    return inTransaction(this.database, async (client) => {
      const repository = new ProviderExecutionRepository(client);
      const state = await repository.findForUpdate(payload.providerJobId);
      if (!state) {
        throw new ProviderExecutionError(
          "PROVIDER_JOB_NOT_FOUND",
          `Provider job ${payload.providerJobId} does not exist`
        );
      }
      if (state.status !== "queued") {
        return { outcome: "noop", providerResultId: null };
      }
      if (
        payload.promptJobId !== state.prompt_job_id ||
        payload.provider !== state.provider ||
        payload.model !== state.model
      ) {
        throw new ProviderExecutionError(
          "PROVIDER_JOB_MESSAGE_MISMATCH",
          "Message identifiers or provider selection do not match authoritative state",
          true
        );
      }
      const adapter = this.adapters.resolve(state.provider, state.model);
      if (
        state.prompt_status !== "processing" ||
        state.prompt_text === null ||
        !state.prompt_text.trim()
      ) {
        throw new ProviderExecutionError(
          "PROMPT_NOT_RENDERED",
          "Provider execution requires a nonblank rendered prompt",
          true
        );
      }
      if (state.analysis_run_status === "paused_budget") {
        await pauseCurrentJob(repository, state);
        return {
          outcome: "paused_budget",
          providerResultId: null,
          budgetPolicyId: null
        };
      }
      const budget = await new BudgetCheckService(
        new BudgetRepository(client)
      ).checkAndReserve({
        providerJobId: state.provider_job_id,
        provider: state.provider,
        model: state.model,
        workspaceId: state.workspace_id,
        userId: state.user_id,
        anonymousSessionId: state.anonymous_session_id,
        analysisRunId: state.analysis_run_id,
        promptText: state.prompt_text,
        promptType: state.prompt_type,
        promptVersion: state.prompt_version
      });
      if (!budget.allowed) {
        await pauseCurrentJob(repository, state);
        return {
          outcome: "paused_budget",
          providerResultId: null,
          budgetPolicyId: budget.decision.budgetPolicyId
        };
      }

      const execution = await adapter.execute({
        providerJobId: state.provider_job_id,
        provider: state.provider,
        model: state.model,
        promptText: state.prompt_text,
        promptType: state.prompt_type,
        promptVersion: state.prompt_version,
        timeoutMs: this.timeoutMs
      });
      const inputTokens = execution.inputTokens ?? budget.estimate.inputTokens;
      const outputTokens =
        execution.outputTokens ?? budget.estimate.outputTokens;
      const result = await repository.createOrReuseProviderResult({
        providerJobId: state.provider_job_id,
        provider: state.provider,
        modelVersion: execution.modelVersion ?? state.model,
        providerRequestId: execution.providerRequestId,
        rawResponse: execution.rawResponse,
        parsedResponse: execution.parsedEvidence,
        finishReason: execution.finishReason,
        latencyMs: execution.latencyMs
      });
      await repository.createOrReuseProviderActualUsage({
        providerJobId: state.provider_job_id,
        inputTokens,
        outputTokens,
        costMicros: estimateCostMicros({
          provider: state.provider,
          model: state.model,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens
        })
      });
      await new OutboxEventWriterRepository(client).createOrReuse({
        eventKey: `provider_result.created:${result.provider_result_id}`,
        eventType: "provider_result.created",
        eventVersion: 1,
        aggregateType: "provider_result",
        aggregateId: result.provider_result_id,
        headers: { queueName: "scoring_queue" },
        payload: {
          providerResultId: result.provider_result_id,
          providerJobId: state.provider_job_id,
          promptJobId: state.prompt_job_id,
          analysisRunId: state.analysis_run_id
        }
      });
      if (
        !(await repository.markSucceeded(
          state.provider_job_id,
          state.prompt_job_id
        ))
      ) {
        throw new ProviderExecutionError(
          "PROVIDER_JOB_TRANSITION_FAILED",
          "Provider and prompt jobs could not transition to succeeded"
        );
      }
      return {
        outcome: "completed",
        providerResultId: result.provider_result_id
      };
    });
  }
}

async function pauseCurrentJob(
  repository: ProviderExecutionRepository,
  state: {
    provider_job_id: string;
    prompt_job_id: string;
    analysis_run_id: string;
  }
) {
  const reasonMessage =
    "Analysis paused because provider budget was reached before all prompts could be executed.";
  if (
    !(await repository.markBudgetPaused({
      providerJobId: state.provider_job_id,
      promptJobId: state.prompt_job_id,
      analysisRunId: state.analysis_run_id,
      reasonCode: "BUDGET_LIMIT_REACHED",
      reasonMessage
    }))
  ) {
    throw new ProviderExecutionError(
      "BUDGET_PAUSE_TRANSITION_FAILED",
      "Provider work could not transition to paused_budget"
    );
  }
}
