import { ProviderName, TopKValue } from "../config/constants.js";
import type { DomainScheduleCadence, NotificationChannel, NotificationStatus } from "./database.types.js";

export type TraceDocument = {
  provider_analysis_id: number;
  provider_snapshot_id: number;
  domain: string;
  llm_name: ProviderName;
  ranking_prompt_name: string;
  ranking_prompt_text: string;
  ranking_prompt_response: string | null;
  observability_prompt_name: string;
  observability_prompt_text: string;
  observability_prompt_response: string | null;
  scoring_prompt_name: string;
  scoring_prompt_text: string;
  scoring_prompt_response: string | null;
  top_k: TopKValue;
  rank_position: number | null;
  mention_count: number;
  provider_score: number;
  overall_geo_score: number | null;
  status: "completed" | "failed";
  error_type: string | null;
  error_message: string | null;
  retry_count: number;
  timestamp: string;
};

export type ScheduledRunDocument = {
  event: "scheduled_run_enqueued";
  schedule_id: number;
  domain_id: number;
  domain: string;
  analysis_run_id: number;
  bullmq_job_id: string;
  cadence: DomainScheduleCadence;
  previous_next_run_at: string;
  next_run_at: string;
  timestamp: string;
};

export type NotificationDocument = {
  event: "notification_queued" | "notification_sent" | "notification_failed";
  notification_id: number;
  domain_id: number;
  analysis_diff_id: number;
  channel: NotificationChannel;
  status: NotificationStatus;
  payload: unknown;
  error_message: string | null;
  timestamp: string;
};
