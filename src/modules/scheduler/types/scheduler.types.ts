import type {
  CategorySelectionMode,
  JsonObject,
  PromptDepth
} from "../../../common/types/database.types.js";

export type DueSchedulerJob = {
  scheduler_job_id: string;
  workspace_id: string;
  created_by_user_id: string;
  starting_entity_path_id: string;
  category_selection_mode: CategorySelectionMode;
  prompt_depth: PromptDepth;
  prompt_policy_version: string;
  schedule_expression: string;
  timezone: string;
  request_payload: JsonObject;
  next_run_at: Date;
  normalized_domain: string;
  domain_id: string;
  category_id: string | null;
  brand_id: string | null;
  product_id: string | null;
  use_context_id: string | null;
};
