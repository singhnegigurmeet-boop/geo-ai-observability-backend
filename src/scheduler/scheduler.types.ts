import type { JsonObject, ProviderName } from "../types/database.types.js";

export type DueSchedulerJob = {
  scheduler_job_id: string;
  workspace_id: string;
  created_by_user_id: string;
  starting_entity_path_id: string;
  schedule_expression: string;
  timezone: string;
  request_payload: JsonObject;
  next_run_at: Date;
  normalized_domain: string;
  category_id: string | null;
  brand_id: string | null;
  product_id: string | null;
  use_context_id: string | null;
  authorization_valid: boolean;
  hierarchy_valid: boolean;
};

export type SchedulerRequestPolicy = {
  providerModels: Array<{
    provider: ProviderName;
    model: string;
  }>;
};
