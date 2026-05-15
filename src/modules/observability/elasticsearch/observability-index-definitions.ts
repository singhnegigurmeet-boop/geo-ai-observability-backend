import { PROVIDERS } from "../../../config/constants.js";
import type { ProviderName } from "../../../config/constants.js";

export const OBSERVABILITY_INDEXES = {
  providerResponses: {
    openai: "openai-responses",
    gemini: "gemini-responses",
    claude: "claude-responses"
  },
  scheduledRuns: "scheduled-runs",
  notifications: "notifications"
} as const satisfies {
  providerResponses: Record<ProviderName, string>;
  scheduledRuns: string;
  notifications: string;
};

const providerTraceMappings = {
  dynamic: "strict",
  properties: {
    provider_analysis_id: { type: "integer" },
    provider_snapshot_id: { type: "integer" },
    domain: { type: "keyword" },
    llm_name: { type: "keyword" },
    ranking_prompt_name: { type: "keyword" },
    ranking_prompt_text: { type: "text" },
    ranking_prompt_response: { type: "text" },
    observability_prompt_name: { type: "keyword" },
    observability_prompt_text: { type: "text" },
    observability_prompt_response: { type: "text" },
    scoring_prompt_name: { type: "keyword" },
    scoring_prompt_text: { type: "text" },
    scoring_prompt_response: { type: "text" },
    top_k: { type: "integer" },
    rank_position: { type: "integer" },
    mention_count: { type: "integer" },
    provider_score: { type: "float" },
    overall_geo_score: { type: "float" },
    status: { type: "keyword" },
    error_type: { type: "keyword" },
    error_message: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 512 } } },
    retry_count: { type: "integer" },
    timestamp: { type: "date" }
  }
} as const;

const scheduledRunMappings = {
  dynamic: "strict",
  properties: {
    event: { type: "keyword" },
    schedule_id: { type: "integer" },
    domain_id: { type: "integer" },
    domain: { type: "keyword" },
    analysis_run_id: { type: "integer" },
    bullmq_job_id: { type: "keyword" },
    cadence: { type: "keyword" },
    previous_next_run_at: { type: "date" },
    next_run_at: { type: "date" },
    timestamp: { type: "date" }
  }
} as const;

const notificationMappings = {
  dynamic: "strict",
  properties: {
    event: { type: "keyword" },
    notification_id: { type: "integer" },
    domain_id: { type: "integer" },
    analysis_diff_id: { type: "integer" },
    channel: { type: "keyword" },
    status: { type: "keyword" },
    payload: { type: "object", enabled: false },
    error_message: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 512 } } },
    timestamp: { type: "date" }
  }
} as const;

export const OBSERVABILITY_INDEX_DEFINITIONS = [
  ...PROVIDERS.map((provider) => ({
    key: `${provider}Responses`,
    index: OBSERVABILITY_INDEXES.providerResponses[provider],
    mappings: providerTraceMappings
  })),
  {
    key: "scheduledRuns",
    index: OBSERVABILITY_INDEXES.scheduledRuns,
    mappings: scheduledRunMappings
  },
  {
    key: "notifications",
    index: OBSERVABILITY_INDEXES.notifications,
    mappings: notificationMappings
  }
] as const;
