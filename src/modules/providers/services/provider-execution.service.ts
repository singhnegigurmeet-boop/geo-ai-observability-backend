import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { BudgetCheckService } from "../../budgets/services/budget-check.service.js";
import { BudgetRepository } from "../../budgets/repositories/budget.repository.js";
import { estimateCostMicros } from "../../budgets/policies/provider-pricing.policy.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import { ExecutionStateService } from "../../execution/services/execution-state.service.js";
import type { ProviderName } from "../../../common/types/database.types.js";
import { ReportAggregationService } from "../../reports/services/report-aggregation.service.js";
import { ReportRepository } from "../../reports/repositories/report.repository.js";
import { ProviderAdapterRegistry } from "../adapters/provider-adapter.registry.js";
import { ProviderExecutionError } from "../errors/provider-execution.error.js";
import { ProviderExecutionRepository } from "../repositories/provider-execution.repository.js";
import type { ProviderJobCreatedPayload } from "../messages/provider-worker.messages.js";
import { providerModelProfile } from "../registry/provider-model.registry.js";
import {
  retainGeneratedContent,
  validateClassificationOutput,
  validateProviderOutput
} from "./provider-output-validation.service.js";
import { requiresScoring } from "../../prompts/policies/prompt-policy.registry.js";
import type {
  ProviderAdapter,
  ProviderGeneratedOutput
} from "../types/provider-adapter.types.js";
import type { ProviderExecutionState } from "../repositories/provider-execution.repository.js";

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
      await repository.lockAnalysisRunForProviderJob(payload.providerJobId);
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
      if (state.job_kind === "domain_category_classification") {
        return this.executeClassification(client, repository, state, adapter);
      }
      if (
        state.job_kind !== "normal_prompt" ||
        state.prompt_job_id === null ||
        state.prompt_type === null ||
        state.prompt_depth === null ||
        state.business_prompt_version === null ||
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
        await pauseCurrentJob(repository, {
          ...state,
          prompt_job_id: state.prompt_job_id
        });
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
      const modelProfile = providerModelProfile(state.provider, state.model);
      if (
        !modelProfile ||
        modelProfile.modelProfileVersion !== state.model_profile_version
      ) {
        throw new ProviderExecutionError(
          "MODEL_PROFILE_VERSION_MISMATCH",
          "Frozen provider model profile is unavailable",
          true
        );
      }
      const exactTargetName = exactTargetNameFromPayload(
        state.request_payload
      );
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
        promptDepth: state.prompt_depth
      });
      if (!budget.allowed) {
        await pauseCurrentJob(repository, {
          ...state,
          prompt_job_id: state.prompt_job_id
        });
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
          promptDepth: state.prompt_depth,
          responseContractVersion: state.response_contract_version,
          structuredOutputMode: state.structured_output_mode,
          maximumOutputTokens:
            modelProfile.maximumOutputTokens[state.prompt_depth],
          exactTargetName,
          timeoutMs: this.timeoutMs
        });
      } catch (error) {
        if (
          error instanceof ProviderExecutionError &&
          error.invalidEvidence
        ) {
          const retained = retainGeneratedContent(
            typeof error.invalidEvidence.rawResponse === "string"
              ? error.invalidEvidence.rawResponse
              : JSON.stringify(error.invalidEvidence.rawResponse ?? null)
          );
          const result = await repository.createOrReuseProviderResult({
              providerJobId: state.provider_job_id,
              provider: state.provider,
              responseContractVersion: state.response_contract_version,
              modelVersion: state.model,
              ...retained,
              providerMetadata: {},
              validatedResponse: null,
              validationErrors: error.invalidEvidence.validationErrors.map(
                (message) => ({
                  layer: "provider_transport",
                  code: "GENERATED_CONTENT_MISSING",
                  message
                })
              ),
              contextValidationStatus: "invalid",
              providerRequestId: null,
              finishReason: null,
              latencyMs: 0
            });
          await repository.markSucceeded(state.provider_job_id);
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
      const retained = retainGeneratedContent(execution.generatedContent);
      const validation = validateProviderOutput({
        generatedContent: execution.generatedContent,
        promptType: state.prompt_type,
        promptDepth: state.prompt_depth,
        responseContractVersion: state.response_contract_version,
        exactTargetName
      });
      const result = await repository.createOrReuseProviderResult({
        providerJobId: state.provider_job_id,
        provider: state.provider,
        responseContractVersion: state.response_contract_version,
        modelVersion: execution.modelVersion ?? state.model,
        providerRequestId: execution.providerRequestId,
        ...retained,
        providerMetadata: execution.sanitizedProviderMetadata,
        validatedResponse: validation.valid
          ? validation.validatedResponse
          : null,
        validationErrors: validation.validationErrors,
        contextValidationStatus: validation.contextValidationStatus,
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
      if (validation.valid && requiresScoring(state.prompt_type)) {
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
      }
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
      if (!validation.valid || !requiresScoring(state.prompt_type)) {
        await createReportSnapshot(client, state.analysis_run_id);
      }
      return {
        outcome: "completed",
        providerResultId: result.provider_result_id
      };
    });
  }

  private async executeClassification(
    client: DatabaseExecutor,
    repository: ProviderExecutionRepository,
    state: ProviderExecutionState,
    adapter: ProviderAdapter
  ): Promise<ProviderExecutionOutcome> {
    if (
      state.classification_job_id === null ||
      state.classification_status !== "processing" ||
      !state.prompt_text?.trim() ||
      state.classification_input_payload === null
    ) {
      throw new ProviderExecutionError(
        "CLASSIFICATION_NOT_RENDERED",
        "Classification provider execution requires a rendered active job",
        true
      );
    }
    const profile = providerModelProfile(state.provider, state.model);
    if (
      !profile ||
      profile.modelProfileVersion !== state.model_profile_version
    ) {
      throw new ProviderExecutionError(
        "MODEL_PROFILE_VERSION_MISMATCH",
        "Frozen classification model profile is unavailable",
        true
      );
    }
    const classificationContext = parseClassificationContext(
      state.classification_input_payload
    );
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
      promptType: "domain_category_classification",
      promptDepth: "weak"
    });
    if (!budget.allowed) {
      await repository.markBudgetPaused({
        providerJobId: state.provider_job_id,
        promptJobId: "",
        analysisRunId: state.analysis_run_id,
        reasonCode: "BUDGET_LIMIT_REACHED",
        reasonMessage:
          "Analysis paused because the classification budget was reached."
      });
      await client.query(
        `
          UPDATE analysis_runs
          SET status = 'paused_budget',
              error_code = 'BUDGET_LIMIT_REACHED',
              error_message =
                'Analysis paused before domain category classification.',
              updated_at = now()
          WHERE analysis_run_id = $1
            AND status IN ('queued', 'processing')
        `,
        [state.analysis_run_id]
      );
      return {
        outcome: "paused_budget",
        providerResultId: null,
        budgetPolicyId: budget.decision.budgetPolicyId
      };
    }
    if (!(await repository.markProcessing(state.provider_job_id))) {
      throw new ProviderExecutionError(
        "PROVIDER_JOB_TRANSITION_FAILED",
        "Classification provider job could not transition to processing"
      );
    }
    let execution: ProviderGeneratedOutput;
    try {
      execution = await adapter.execute({
        providerJobId: state.provider_job_id,
        provider: state.provider,
        model: state.model,
        promptText: state.prompt_text,
        promptType: "domain_category_classification",
        promptDepth: "weak",
        responseContractVersion: state.response_contract_version,
        structuredOutputMode: state.structured_output_mode,
        maximumOutputTokens: profile.maximumOutputTokens.weak,
        exactTargetName: classificationContext.domainName,
        classificationCandidates: classificationContext.candidates,
        timeoutMs: this.timeoutMs
      });
    } catch (error) {
      if (
        !(error instanceof ProviderExecutionError) ||
        !error.invalidEvidence
      ) {
        throw error;
      }
      execution = {
        generatedContent:
          typeof error.invalidEvidence.rawResponse === "string"
            ? error.invalidEvidence.rawResponse
            : JSON.stringify(error.invalidEvidence.rawResponse ?? null),
        sanitizedProviderMetadata: {
          transportValidationError: error.code
        },
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        finishReason: null,
        providerRequestId: null,
        modelVersion: state.model,
        latencyMs: 0
      };
    }
    const active = await client.query<{ category_id: string }>(
      `
        SELECT category.category_id
        FROM analysis_run_requested_categories AS requested
        JOIN categories AS category
          ON category.category_id = requested.category_id AND category.is_active
        WHERE requested.analysis_run_id = $1
          AND category.category_id = ANY($2::bigint[])
      `,
      [
        state.analysis_run_id,
        classificationContext.candidates.map(
          (candidate) => candidate.categoryId
        )
      ]
    );
    const validation = validateClassificationOutput({
      generatedContent: execution.generatedContent,
      candidateIds: classificationContext.candidates.map(
        (candidate) => candidate.categoryId
      ),
      activeFrozenCategoryIds: new Set(
        active.rows.map((row) => row.category_id)
      )
    });
    const retained = retainGeneratedContent(execution.generatedContent);
    const result = await repository.createOrReuseProviderResult({
      providerJobId: state.provider_job_id,
      provider: state.provider,
      responseContractVersion: state.response_contract_version,
      modelVersion: execution.modelVersion ?? state.model,
      providerRequestId: execution.providerRequestId,
      ...retained,
      providerMetadata: execution.sanitizedProviderMetadata,
      validatedResponse: validation.valid
        ? validation.validatedResponse
        : null,
      validationErrors: validation.validationErrors,
      contextValidationStatus: validation.contextValidationStatus,
      finishReason: execution.finishReason,
      latencyMs: execution.latencyMs
    });
    const inputTokens = execution.inputTokens ?? budget.estimate.inputTokens;
    const outputTokens =
      execution.outputTokens ?? budget.estimate.outputTokens;
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
    await repository.markSucceeded(state.provider_job_id);
    await new OutboxEventWriterRepository(client).createOrReuse({
      eventKey:
        `domain_category_classification_result.created:${result.provider_result_id}`,
      eventType: "domain_category_classification_result.created",
      eventVersion: 1,
      aggregateType: "provider_result",
      aggregateId: result.provider_result_id,
      headers: {
        queueName: "domain_category_classification_result_queue"
      },
      payload: { providerResultId: result.provider_result_id }
    });
    return {
      outcome: "completed",
      providerResultId: result.provider_result_id
    };
  }
}

function exactTargetNameFromPayload(payload: Record<string, unknown>) {
  const context = payload.entityPathContext;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new ProviderExecutionError(
      "ENTITY_PATH_CONTEXT_MISSING",
      "Provider job request has no frozen entity path context",
      true
    );
  }
  const record = context as Record<string, unknown>;
  for (const key of ["useContext", "product", "brand", "category", "domain"]) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const name = (value as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) return name;
    }
  }
  throw new ProviderExecutionError(
    "ENTITY_PATH_TARGET_MISSING",
    "Provider job context has no exact target",
    true
  );
}

function parseClassificationContext(payload: Record<string, unknown>) {
  const domain = payload.domain;
  const candidates = payload.candidates;
  if (
    !domain ||
    typeof domain !== "object" ||
    Array.isArray(domain) ||
    typeof (domain as Record<string, unknown>).name !== "string" ||
    !Array.isArray(candidates)
  ) {
    throw new ProviderExecutionError(
      "CLASSIFICATION_CONTEXT_INVALID",
      "Frozen classification context is invalid",
      true
    );
  }
  const parsedCandidates = candidates.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      typeof candidate.categoryId !== "string" ||
      typeof candidate.categoryName !== "string"
    ) {
      throw new ProviderExecutionError(
        "CLASSIFICATION_CONTEXT_INVALID",
        "Frozen classification candidate is invalid",
        true
      );
    }
    return {
      categoryId: candidate.categoryId,
      categoryName: candidate.categoryName
    };
  });
  return {
    domainName: (domain as Record<string, string>).name,
    candidates: parsedCandidates
  };
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
