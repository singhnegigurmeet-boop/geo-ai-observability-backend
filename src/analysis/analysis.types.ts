import type {
  AnalysisExecutionStatus,
  AnalysisRunSource,
  EntityPathType,
  JsonObject
} from "../types/database.types.js";

export type CanonicalAnalysisRequest = JsonObject & {
  domain: string;
  categoryId: string | null;
  brandId: string | null;
  productId: string | null;
  useContextId: string | null;
};

export type CreateAnalysisResponse = {
  analysisRunId: string;
  startingEntityPathId: string;
  status: "queued";
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
