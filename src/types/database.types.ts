import { ProviderName, ProviderStatus, TopKValue } from "../config/constants.js";

export type DomainRow = {
  domain_id: number;
  domain: string;
  created_on: Date;
  updated_on: Date;
  is_active: boolean;
};

export type CategoryRow = {
  category_id: number;
  category: string;
  created_on: Date;
  updated_on: Date;
  is_active: boolean;
};

export type BrandRow = {
  brand_id: number;
  brand_name: string;
  created_on: Date;
  updated_on: Date;
  is_active: boolean;
};

export type ProductRow = {
  product_id: number;
  product_name: string;
  created_on: Date;
  updated_on: Date;
  is_active: boolean;
};

export type UseContextRow = {
  context_id: number;
  context: string;
  created_on: Date;
  updated_on: Date;
  is_active: boolean;
};

export type EntityPathType = "category" | "brand" | "product_context";

export type EntityPathRow = {
  path_id: number;
  domain_id: number;
  category_id: number;
  brand_id: number | null;
  product_id: number | null;
  context_id: number | null;
  path_type: EntityPathType;
  created_on: Date;
  updated_on: Date;
  is_active: boolean;
};

export type EntityPathInput = {
  domainId: number;
  categoryId: number;
  brandId?: number | null;
  productId?: number | null;
  contextId?: number | null;
  pathType: EntityPathType;
};

export type DiscoveryRequestKind = "domain" | "brand" | "product";
export type DiscoveryRequestStatus = "pending" | "approved" | "rejected" | "resolved";

export type DiscoveryRequestRow = {
  request_id: number;
  kind: DiscoveryRequestKind;
  domain: string;
  category_id: number | null;
  brand_id: number | null;
  brand_name: string | null;
  product_name: string | null;
  notes: string | null;
  status: DiscoveryRequestStatus;
  created_on: Date;
  updated_on: Date;
  is_active: boolean;
};

export type AnalysisRunStatus =
  | "queued"
  | "processing"
  | "completed"
  | "partial_success"
  | "failed"
  | "cancelled";
export type AnalysisRunSource = "manual" | "scheduled" | "retry";

export type AnalysisRunRow = {
  analysis_run_id: number;
  domain_id: number;
  request_payload: unknown;
  status: AnalysisRunStatus;
  created_on: Date;
  updated_on: Date;
  is_active: boolean;
};

export type AnalysisRunInput = {
  domainId: number;
  requestPayload: unknown;
  status?: AnalysisRunStatus;
};

export type AnalysisRunFilters = {
  domainId?: number;
  status?: AnalysisRunStatus;
  limit?: number;
  offset?: number;
};

export type AnalysisRunItemStatus = "queued" | "processing" | "completed" | "failed" | "skipped" | "cancelled";

export type AnalysisRunItemRow = {
  run_item_id: number;
  analysis_run_id: number;
  path_id: number;
  status: AnalysisRunItemStatus;
  created_on: Date;
  updated_on: Date;
  is_active: boolean;
};

export type AnalysisRunItemWithPathRow = AnalysisRunItemRow & EntityPathRow;

export type AnalysisRunItemsInput = {
  analysisRunId: number;
  pathIds: number[];
};

export type ProviderAnalysisInput = {
  analysisRunId?: number;
  domainId: number;
  llmName: ProviderName;
  topK: TopKValue;
  rankPosition: number | null;
  mentionCount: number;
  score: number;
  status: ProviderStatus;
  errorMessage: string | null;
};

export type ProviderAnalysisStatusRow = {
  llm_name: ProviderName;
  status: ProviderStatus;
  error_message: string | null;
};

export type ProviderAnalysisScoreRow = {
  llm_name: ProviderName;
  top_k: TopKValue;
  rank_position: number | null;
  mention_count: number;
  score: string;
  status: ProviderStatus;
};

export type ProviderLatestScoreRow = {
  id: number;
  domain_id: number;
  llm_name: ProviderName;
  top_k: TopKValue;
  rank_position: number | null;
  mention_count: number;
  score: string;
  status: ProviderStatus;
  error_message: string | null;
  last_run: Date;
  updated_at: Date;
};

export type ProviderSnapshotRow = {
  id: number;
  domain_id: number;
  analysis_run_id: number | null;
  llm_name: ProviderName;
  top_k: TopKValue;
  rank_position: number | null;
  mention_count: number;
  score: string;
  status: ProviderStatus;
  error_message: string | null;
  created_at: Date;
};

export type LatestProviderSnapshotRow = Pick<
  ProviderSnapshotRow,
  "llm_name" | "top_k" | "mention_count" | "score" | "status"
>;

export type VisibilityScoreRow = {
  id: number;
  domain_id: number;
  analysis_run_id: number | null;
  openai_score: number;
  gemini_score: number;
  claude_score: number;
  coverage_score: number;
  consistency_score: number;
  mention_frequency_score: number;
  overall_geo_score: number;
  created_at: Date;
};

export type AnalysisDiffType =
  | "visibility_score_dropped"
  | "brand_rank_changed"
  | "provider_mention_disappeared"
  | "provider_recovered";

export type AnalysisDiffSeverity = "info" | "warning" | "critical";

export type AnalysisDiffRow = {
  id: number;
  domain_id: number;
  analysis_run_id: number;
  previous_analysis_run_id: number | null;
  diff_type: AnalysisDiffType;
  provider: ProviderName | null;
  old_value: unknown;
  new_value: unknown;
  severity: AnalysisDiffSeverity;
  created_at: Date;
};

export type AnalysisDiffInput = {
  domainId: number;
  analysisRunId: number;
  previousAnalysisRunId: number | null;
  diffType: AnalysisDiffType;
  provider: ProviderName | null;
  oldValue: unknown;
  newValue: unknown;
  severity: AnalysisDiffSeverity;
};

export type DomainScheduleCadence = "weekly";

export type DomainScheduleRow = {
  id: number;
  domain_id: number;
  domain: string;
  cadence: DomainScheduleCadence;
  enabled: boolean;
  last_enqueued_at: Date | null;
  next_run_at: Date;
  created_at: Date;
  updated_at: Date;
};

export type DomainScheduleInput = {
  domainId: number;
  cadence: DomainScheduleCadence;
  enabled: boolean;
  nextRunAt: Date | null;
};

export type NotificationChannel = "log";
export type NotificationStatus = "pending" | "sent" | "failed";

export type NotificationRow = {
  id: number;
  domain_id: number;
  analysis_diff_id: number;
  channel: NotificationChannel;
  status: NotificationStatus;
  payload: unknown;
  error_message: string | null;
  created_at: Date;
  sent_at: Date | null;
};

export type NotificationInput = {
  domainId: number;
  analysisDiffId: number;
  channel: NotificationChannel;
  payload: unknown;
};
