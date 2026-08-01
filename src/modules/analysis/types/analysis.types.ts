import type {
  AnalysisExecutionStatus,
  AnalysisRunSource,
  EntityPathType,
  JsonObject,
  PromptDepth,
  PromptType,
  ProviderName
} from "../../../common/types/database.types.js";

export type CanonicalAnalysisRequest = JsonObject & {
  domain: string;
  categoryId: string | null;
  brandId: string | null;
  productId: string | null;
  useContextId: string | null;
  categorySelection: {
    mode: "all" | "selected";
    categoryIds: string[];
  };
  promptDepth: PromptDepth;
  promptPolicyVersion: string;
  providerModels: Array<{
    provider: ProviderName;
    model: string;
    modelProfileVersion: string;
    providerInstructionProfile: string;
    structuredOutputMode: string;
  }>;
  canonicalPlannerVersion: string;
  canonicalRequestHash: string;
  planningEstimate: JsonObject;
};

export type PlanningEstimateRange = {
  minimum: number;
  maximum: number;
};

export type CanonicalAnalysisPlan = {
  normalizedDomain: string;
  frozenCategorySelection: {
    mode: "all" | "selected";
    categoryIds: string[];
  };
  frozenRequestedCategoryCount: number;
  hierarchyReady: boolean;
  discoveryRequired: boolean;
  estimatedEligibleCategories: PlanningEstimateRange;
  plannedEntityPaths: JsonObject[];
  applicablePromptsByPath: readonly PromptType[];
  applicablePromptCountEstimate: PlanningEstimateRange;
  resolvedProviderModels: Array<{
    provider: ProviderName;
    model: string;
    queueName: string;
    modelProfileVersion: string;
    preferredStructuredOutputMode: string;
    providerInstructionProfile: string;
  }>;
  expectedExecutions: {
    normalProviderJobCountEstimate: PlanningEstimateRange;
    totalProviderJobCountEstimate: PlanningEstimateRange;
  };
  promptDepth: PromptDepth;
  promptPolicyVersion: string;
  tokenEstimate: JsonObject;
  costEstimate: JsonObject;
  normalAnalysisEstimate: JsonObject;
  byProviderModel: JsonObject[];
  safetyLimits: JsonObject;
  canonicalRequestPayload: CanonicalAnalysisRequest;
  canonicalRequestHash: string;
};

export type AnalysisPreviewResponse = {
  normalizedDomain: string;
  categorySelectionMode: "all" | "selected";
  frozenCategoryIds: string[];
  frozenRequestedCategoryCount: number;
  hierarchyReady: boolean;
  discoveryRequired: boolean;
  estimatedSelectedPathCount: PlanningEstimateRange;
  applicablePromptCountEstimate: PlanningEstimateRange;
  applicablePromptTypes: PromptType[];
  resolvedModelCount: number;
  resolvedProviderModels: JsonObject[];
  normalProviderJobCountEstimate: PlanningEstimateRange;
  totalProviderJobCountEstimate: PlanningEstimateRange;
  tokenEstimate: JsonObject;
  costEstimate: JsonObject;
  normalAnalysisEstimate: JsonObject;
  byProviderModel: JsonObject[];
  safetyLimits: JsonObject;
  canonicalPlannerVersion: string;
  canonicalRequestHash: string;
  estimateNotice: string;
};

export type CreateAnalysisResponse = {
  preAnalysisRequestId: string;
  analysisRunId: string | null;
  status: "accepted" | "checking_hierarchy" | "discovering" | "planning" | "analysis_created" | "completed_without_analysis" | "failed" | "paused_budget" | "cancelled";
  idempotentReplay: boolean;
  createdAt: string;
};

export type AnalysisRunStatusRecord = {
  analysis_run_id: string;
  status: AnalysisExecutionStatus;
  source: AnalysisRunSource;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  entity_path_id: string;
  path_type: EntityPathType;
  domain_id: string;
  normalized_domain: string;
  category_id: string | null;
  brand_id: string | null;
  product_id: string | null;
  use_context_id: string | null;
};

export type AnalysisRunStatusResponse = {
  analysisRunId: string;
  status: AnalysisExecutionStatus;
  source: AnalysisRunSource;
  startingPath: {
    entityPathId: string;
    pathType: EntityPathType;
    domainId: string;
    normalizedDomain: string;
    categoryId: string | null;
    brandId: string | null;
    productId: string | null;
    useContextId: string | null;
  };
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AnalysisReportRecord = {
  analysis_run_id: string;
  report_id: string;
  report_version: string;
  revision: number;
  status: "completed" | "partial" | "failed";
  report_data: JsonObject;
  rendered_text: string | null;
  generated_at: Date;
};

export type AnalysisReportResponse = {
  analysisRunId: string;
  reportId: string;
  reportVersion: string;
  revision: number;
  status: "completed" | "partial" | "failed";
  report: JsonObject;
  renderedText: string | null;
  generatedAt: string;
};
