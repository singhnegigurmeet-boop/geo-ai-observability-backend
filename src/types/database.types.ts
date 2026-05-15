import { ProviderName, ProviderStatus, TopKValue } from "../config/constants.js";

export type DomainRow = {
  id: number;
  domain: string;
  created_at: Date;
  updated_at: Date;
};

export type AnalysisRunStatus = "queued" | "processing" | "completed" | "partial_success" | "failed";
export type AnalysisRunSource = "manual" | "scheduled" | "retry";

export type AnalysisRunRow = {
  id: number;
  domain_id: number;
  bullmq_job_id: string | null;
  status: AnalysisRunStatus;
  source: AnalysisRunSource;
  started_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
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
