import { ProviderName, ProviderStatus, TopKValue } from "../config/constants.js";

export type DomainRow = {
  id: number;
  domain: string;
  created_at: Date;
  updated_at: Date;
};

export type AnalysisRunStatus = "queued" | "processing" | "completed" | "partial_success" | "failed";

export type AnalysisRunRow = {
  id: number;
  domain_id: number;
  bullmq_job_id: string | null;
  status: AnalysisRunStatus;
  started_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ProviderAnalysisInput = {
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
  openai_score: number;
  gemini_score: number;
  claude_score: number;
  coverage_score: number;
  consistency_score: number;
  mention_frequency_score: number;
  overall_geo_score: number;
  created_at: Date;
};
