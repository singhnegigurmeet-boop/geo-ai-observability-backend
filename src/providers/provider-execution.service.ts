import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { BudgetCheckService } from "../budgets/budget-check.service.js";
import { BudgetRepository } from "../budgets/budget.repository.js";
import { estimateCostMicros } from "../budgets/provider-pricing.policy.js";
import { OutboxEventWriterRepository } from "../outbox/outbox-event-writer.repository.js";
import { ExecutionStateService } from "../execution/execution-state.service.js";
import type { ProviderName } from "../types/database.types.js";
import { ReportAggregationService } from "../reports/report-aggregation.service.js";
import { ReportRepository } from "../reports/report.repository.js";
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
    payload: ProviderJobCreatedPayload,
    expectedProvider?: ProviderName
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
      if (expectedProvider && expectedProvider !== state.provider) {
        throw new ProviderExecutionError(
          "PROVIDER_QUEUE_MISMATCH",
          `Provider job does not belong on the ${expectedProvider} queue`,
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
        await new ExecutionStateService(client).recalculateRun(
          state.analysis_run_id
        );
        await createReportSnapshot(client, state.analysis_run_id);
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
        await new ExecutionStateService(client).recalculateRun(
          state.analysis_run_id
        );
        await createReportSnapshot(client, state.analysis_run_id);
        return {
          outcome: "paused_budget",
          providerResultId: null,
          budgetPolicyId: budget.decision.budgetPolicyId
        };
      }
      if (!(await repository.markProcessing(state.provider_job_id))) {
        throw new ProviderExecutionError(
          "PROVIDER_JOB_TRANSITION_FAILED",
          "Provider job could not transition to processing"
        );
      }

      let execution;
      try {
        execution = await adapter.execute({
          providerJobId: state.provider_job_id,
          provider: state.provider,
          model: state.model,
          promptText: state.prompt_text,
          promptType: state.prompt_type,
          promptVersion: state.prompt_version,
          timeoutMs: this.timeoutMs
        });
      } catch (error) {
        if (
          error instanceof ProviderExecutionError &&
          error.invalidEvidence
        ) {
          const result =
            await repository.createOrReuseInvalidProviderResult({
              providerJobId: state.provider_job_id,
              provider: state.provider,
              modelVersion: state.model,
              rawResponse: error.invalidEvidence.rawResponse,
              validationErrors: error.invalidEvidence.validationErrors
            });
          await repository.markFailed(
            state.provider_job_id,
            "INVALID_PROVIDER_EVIDENCE",
            "Provider returned evidence that could not be validated"
          );
          await new ExecutionStateService(client).recalculateRun(
            state.analysis_run_id
          );
          await createReportSnapshot(client, state.analysis_run_id);
          return {
            outcome: "completed",
            providerResultId: result.provider_result_id
          };
        }
        throw error;
      }
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
          providerResultId: result.provider_result_id
        }
      });
      if (
        !(await repository.markSucceeded(state.provider_job_id))
      ) {
        throw new ProviderExecutionError(
          "PROVIDER_JOB_TRANSITION_FAILED",
          "Provider and prompt jobs could not transition to succeeded"
        );
      }
      await new ExecutionStateService(client).recalculateRun(
        state.analysis_run_id
      );
      return {
        outcome: "completed",
        providerResultId: result.provider_result_id
      };
    });
  }
}

function createReportSnapshot(
  database: DatabaseExecutor,
  analysisRunId: string
) {
  return new ReportAggregationService(
    new ReportRepository(database)
  ).createIfReady(analysisRunId);
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
