import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { BudgetCheckService } from "../budgets/budget-check.service.js";
import { BudgetRepository } from "../budgets/budget.repository.js";
import { estimateCostMicros } from "../budgets/provider-pricing.policy.js";
import { OutboxEventWriterRepository } from "../outbox/outbox-event-writer.repository.js";
import type { JsonObject } from "../types/database.types.js";
import { MockProviderRepository } from "./mock-provider.repository.js";
import { isMockModel } from "./provider-model.policy.js";
import type { ProviderJobCreatedPayload } from "./provider-worker.messages.js";

type MockProviderDatabase = DatabaseExecutor & TransactionPool;

export type MockProviderResult =
  | { outcome: "completed"; providerResultId: string }
  | {
      outcome: "paused_budget";
      providerResultId: null;
      budgetPolicyId: string | null;
    }
  | { outcome: "noop"; providerResultId: null };

export class MockProviderExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MockProviderExecutionError";
  }
}

export class MockProviderService {
  constructor(private readonly database: MockProviderDatabase) {}

  async execute(
    payload: ProviderJobCreatedPayload
  ): Promise<MockProviderResult> {
    return inTransaction(this.database, async (client) => {
      const repository = new MockProviderRepository(client);
      const state = await repository.findForUpdate(payload.providerJobId);
      if (!state) {
        throw new MockProviderExecutionError(
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
        throw new MockProviderExecutionError(
          "PROVIDER_JOB_MESSAGE_MISMATCH",
          "Message identifiers or provider selection do not match authoritative state"
        );
      }
      if (state.provider !== "mock" || !isMockModel(state.model)) {
        throw new MockProviderExecutionError(
          "UNSUPPORTED_PROVIDER_SELECTION",
          "Phase 8 mock worker only executes allowed mock models"
        );
      }
      if (
        state.prompt_status !== "processing" ||
        state.prompt_text === null ||
        !state.prompt_text.trim()
      ) {
        throw new MockProviderExecutionError(
          "PROMPT_NOT_RENDERED",
          "Mock provider requires a nonblank rendered prompt"
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

      const parsedResponse = deterministicEvidence(
        state.provider_job_id,
        state.prompt_type,
        state.model
      );
      const rawResponse = JSON.stringify(parsedResponse);
      const result = await repository.createOrReuseResult({
        providerJobId: state.provider_job_id,
        model: state.model,
        parsedResponse,
        rawResponse
      });
      await repository.createOrReuseActualUsage({
        providerJobId: state.provider_job_id,
        inputTokens: Math.max(1, Math.ceil(state.prompt_text.length / 4)),
        outputTokens: 32,
        costMicros: estimateCostMicros({
          provider: state.provider,
          model: state.model,
          totalTokens:
            Math.max(1, Math.ceil(state.prompt_text.length / 4)) + 32
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
        throw new MockProviderExecutionError(
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
  repository: MockProviderRepository,
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
    throw new MockProviderExecutionError(
      "BUDGET_PAUSE_TRANSITION_FAILED",
      "Provider work could not transition to paused_budget"
    );
  }
}

function deterministicEvidence(
  providerJobId: string,
  promptType: string,
  model: string
): JsonObject {
  return {
    provider: "mock",
    model,
    promptType,
    evidence: [
      {
        claim: `Mock ${promptType} evidence for the selected entity path.`,
        source: "mock-provider",
        confidence: 0.75
      }
    ],
    summary: "Deterministic mock response for Phase 8 integration.",
    evidenceId: `mock-evidence:${providerJobId}`
  };
}
