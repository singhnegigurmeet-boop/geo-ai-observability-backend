import type {
  AnalysisExecutionStatus,
  JobStatus
} from "../../../common/types/database.types.js";
import type {
  ReportExecutionRecord,
  ReportMaterializationRecord
} from "../repositories/report.repository.js";
import {
  expectedExecutionIdentity,
  type ExpectedProviderExecution
} from "./expected-execution-plan.service.js";

export type MaterializationStage =
  | "not_started"
  | "llm_run"
  | "prompt_job"
  | "provider_job"
  | "provider_result"
  | "provider_score";

export type ReconciledExecutionState =
  | "missing_before_fan_out"
  | "pending"
  | "budget_paused"
  | "cancelled"
  | "technical_failure"
  | "invalid"
  | "valid_scored"
  | "valid_diagnostic"
  | "valid_score_pending"
  | "permanent_scoring_failure";

export type MissingExpectedExecution = {
  analysisRunItemId: string;
  entityPathId: string;
  categoryId: string | null;
  promptType: string;
  provider: string;
  model: string;
  missingStage: "llm_run" | "prompt_job" | "provider_job";
  reason: "expected_but_not_materialized";
};

export type ReconciledProviderExecution = {
  expected: ExpectedProviderExecution;
  llmRunId: string | null;
  promptJobId: string | null;
  providerJobId: string | null;
  providerResultId: string | null;
  providerScoreId: string | null;
  materializationStage: MaterializationStage;
  executionState: ReconciledExecutionState;
  missing: MissingExpectedExecution | null;
  actual: ReportMaterializationRecord | null;
};

export function reconcileExpectedProviderExecutions(input: {
  expected: readonly ExpectedProviderExecution[];
  materialized: readonly ReportMaterializationRecord[];
  runStatus: AnalysisExecutionStatus;
}): ReconciledProviderExecution[] {
  const terminalRun = isTerminalRun(input.runStatus);
  const itemRows = new Map<string, ReportMaterializationRecord[]>();
  const promptRows = new Map<string, ReportMaterializationRecord[]>();
  const providerRows = new Map<string, ReportMaterializationRecord>();

  for (const row of input.materialized) {
    push(itemRows, row.analysis_run_item_id, row);
    if (row.prompt_type !== null) {
      push(
        promptRows,
        promptIdentity(row.analysis_run_item_id, row.prompt_type),
        row
      );
    }
    if (
      row.prompt_type !== null &&
      row.provider !== null &&
      row.model !== null &&
      row.provider_job_id !== null
    ) {
      const identity = expectedExecutionIdentity(
        row.analysis_run_item_id,
        row.prompt_type,
        row.provider,
        row.model
      );
      if (providerRows.has(identity)) {
        throw new Error(`Duplicate materialized provider identity: ${identity}`);
      }
      providerRows.set(identity, row);
    }
  }

  return input.expected.map((expected) => {
    const provider = providerRows.get(expected.identity);
    const prompt = promptRows.get(
      promptIdentity(expected.analysisRunItemId, expected.promptType)
    )?.[0];
    const item = itemRows.get(expected.analysisRunItemId)?.[0];
    if (!item?.llm_run_id) {
      return missingExecution(expected, "llm_run", terminalRun, null);
    }
    if (!prompt?.prompt_job_id) {
      return missingExecution(expected, "prompt_job", terminalRun, item);
    }
    if (!provider?.provider_job_id) {
      return missingExecution(expected, "provider_job", terminalRun, prompt);
    }
    return reconcileMaterialized(expected, provider, terminalRun);
  });
}

export function reportExecutionRecords(
  reconciled: readonly ReconciledProviderExecution[]
): ReportExecutionRecord[] {
  return reconciled.flatMap((execution) => {
    const row = execution.actual;
    if (
      row === null ||
      row.prompt_job_id === null ||
      row.prompt_type === null ||
      row.prompt_depth === null ||
      row.business_prompt_version === null ||
      row.response_contract_version === null ||
      row.provider_job_id === null ||
      row.provider === null ||
      row.model === null ||
      row.provider_job_status === null
    ) {
      return [];
    }
    return [
      {
        analysis_run_item_id: row.analysis_run_item_id,
        item_ordinal: row.item_ordinal,
        prompt_job_id: row.prompt_job_id,
        prompt_type: row.prompt_type,
        prompt_depth: row.prompt_depth,
        business_prompt_version: row.business_prompt_version,
        response_contract_version: row.response_contract_version,
        entity_path_id: row.entity_path_id,
        category_id: row.category_id,
        category_name: row.category_name,
        provider_job_id: row.provider_job_id,
        provider_result_id: row.provider_result_id,
        provider_score_id: row.provider_score_id,
        provider: row.provider,
        model: row.model,
        model_profile_version: row.model_profile_version ?? undefined,
        provider_instruction_profile:
          row.provider_instruction_profile ?? undefined,
        structured_output_mode: row.structured_output_mode ?? undefined,
        provider_job_status: row.provider_job_status,
        error_code: row.provider_error_code,
        result_status: row.result_status,
        context_validation_status: row.context_validation_status,
        validated_response: row.validated_response,
        validation_errors: row.validation_errors,
        metric_type: row.metric_type,
        scoring_version: row.scoring_version,
        score: row.score,
        score_components: row.score_components,
        scoring_failure_code: row.scoring_failure_code,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cost_micros: row.cost_micros
        ,
        estimated_input_tokens: row.estimated_input_tokens,
        estimated_output_tokens: row.estimated_output_tokens,
        estimated_cost_micros: row.estimated_cost_micros
      }
    ];
  });
}

function reconcileMaterialized(
  expected: ExpectedProviderExecution,
  row: ReportMaterializationRecord,
  terminalRun: boolean
): ReconciledProviderExecution {
  const providerStatus = row.provider_job_status;
  let executionState: ReconciledExecutionState;
  if (isActiveJob(providerStatus)) {
    executionState = "pending";
  } else if (providerStatus === "paused_budget") {
    executionState = "budget_paused";
  } else if (providerStatus === "cancelled") {
    executionState = "cancelled";
  } else if (row.result_status === "invalid") {
    executionState = "invalid";
  } else if (providerStatus === "failed") {
    executionState = "technical_failure";
  } else if (
    row.result_status !== "valid" ||
    row.context_validation_status !== "valid"
  ) {
    executionState = terminalRun ? "technical_failure" : "pending";
  } else if (!expected.requiresScoring) {
    executionState = "valid_diagnostic";
  } else if (row.provider_score_id !== null && row.score !== null) {
    executionState = "valid_scored";
  } else if (row.scoring_failure_code !== null) {
    executionState = "permanent_scoring_failure";
  } else {
    executionState = "valid_score_pending";
  }
  return {
    expected,
    llmRunId: row.llm_run_id,
    promptJobId: row.prompt_job_id,
    providerJobId: row.provider_job_id,
    providerResultId: row.provider_result_id,
    providerScoreId: row.provider_score_id,
    materializationStage:
      row.provider_score_id !== null
        ? "provider_score"
        : row.provider_result_id !== null
          ? "provider_result"
          : "provider_job",
    executionState,
    missing: null,
    actual: row
  };
}

function missingExecution(
  expected: ExpectedProviderExecution,
  missingStage: "llm_run" | "prompt_job" | "provider_job",
  terminalRun: boolean,
  row: ReportMaterializationRecord | null
): ReconciledProviderExecution {
  return {
    expected,
    llmRunId: row?.llm_run_id ?? null,
    promptJobId: row?.prompt_job_id ?? null,
    providerJobId: null,
    providerResultId: null,
    providerScoreId: null,
    materializationStage:
      missingStage === "llm_run"
        ? "not_started"
        : missingStage === "prompt_job"
          ? "llm_run"
          : "prompt_job",
    executionState: terminalRun ? "missing_before_fan_out" : "pending",
    missing: {
      analysisRunItemId: expected.analysisRunItemId,
      entityPathId: expected.entityPathId,
      categoryId: expected.categoryId,
      promptType: expected.promptType,
      provider: expected.provider,
      model: expected.model,
      missingStage,
      reason: "expected_but_not_materialized"
    },
    actual: null
  };
}

function promptIdentity(analysisRunItemId: string, promptType: string) {
  return `${analysisRunItemId}\u0000${promptType}`;
}

function push(
  map: Map<string, ReportMaterializationRecord[]>,
  key: string,
  value: ReportMaterializationRecord
) {
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
}

function isActiveJob(status: JobStatus | null) {
  return (
    status === "pending" ||
    status === "queued" ||
    status === "processing"
  );
}

export function isTerminalRun(status: AnalysisExecutionStatus) {
  return (
    status === "completed" ||
    status === "partial_success" ||
    status === "failed" ||
    status === "cancelled"
  );
}
