export type DbId = string;
export type NumericString = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type UserStatus = "active" | "disabled" | "deleted";
export type SessionStatus = "active" | "revoked" | "expired";
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
export type WorkspaceRoleChangeStatus = "pending" | "approved" | "rejected" | "cancelled";
export type EntityPathType = "domain" | "category" | "brand" | "product" | "use_context";
export type AnalysisRunSource = "manual" | "scheduled";
export type AnalysisExecutionStatus =
  | "queued"
  | "processing"
  | "paused_budget"
  | "completed"
  | "partial_success"
  | "failed"
  | "cancelled";
export type PromptType = "competitor" | "ranking" | "visibility" | "price_range" | "pros_cons";
export type JobStatus =
  | "pending"
  | "queued"
  | "processing"
  | "paused_budget"
  | "succeeded"
  | "failed"
  | "cancelled";
export type ProviderName = "mock" | "openai" | "gemini" | "claude";
export type ProviderResultStatus = "valid" | "invalid";
export type BudgetScope = "platform_default" | "workspace";
export type BudgetLimitMode = "hard" | "soft";
export type TokenUsageKind = "estimated" | "actual";
export type ReportStatus = "completed" | "partial" | "failed";
export type OutboxStatus = "pending" | "publishing" | "published" | "failed";
export type FailureRecordStatus = "open" | "acknowledged" | "resolved";
export type NotificationStatus = "pending" | "queued" | "sent" | "failed" | "cancelled";
export type NotificationChannel = "internal" | "email" | "webhook";
export type SchedulerJobStatus = "active" | "paused" | "disabled";

export type UserRow = {
  user_id: DbId;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  status: UserStatus;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type UserSessionRow = {
  user_session_id: DbId;
  user_id: DbId;
  token_hash: string;
  status: SessionStatus;
  expires_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  client_metadata: JsonObject;
  created_at: Date;
  updated_at: Date;
};

export type AnonymousSessionRow = {
  anonymous_session_id: DbId;
  token_hash: string;
  status: SessionStatus;
  expires_at: Date;
  last_seen_at: Date | null;
  claimed_by_user_id: DbId | null;
  claimed_workspace_id: DbId | null;
  claimed_at: Date | null;
  client_metadata: JsonObject;
  created_at: Date;
  updated_at: Date;
};

export type WorkspaceRow = {
  workspace_id: DbId;
  workspace_name: string;
  created_by_user_id: DbId;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type WorkspaceMemberRow = {
  workspace_id: DbId;
  user_id: DbId;
  role: WorkspaceRole;
  joined_at: Date;
  updated_at: Date;
};

export type WorkspaceRoleChangeRequestRow = {
  workspace_role_change_request_id: DbId;
  workspace_id: DbId;
  target_user_id: DbId;
  requested_role: WorkspaceRole;
  requested_by_user_id: DbId;
  reviewed_by_user_id: DbId | null;
  status: WorkspaceRoleChangeStatus;
  request_reason: string | null;
  review_note: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type DomainRow = {
  domain_id: DbId;
  normalized_domain: string;
  display_domain: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type CategoryRow = {
  category_id: DbId;
  category_name: string;
  normalized_name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type BrandRow = {
  brand_id: DbId;
  brand_name: string;
  normalized_name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type ProductRow = {
  product_id: DbId;
  product_name: string;
  normalized_name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type UseContextRow = {
  use_context_id: DbId;
  use_context_name: string;
  normalized_name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type DomainCategoryRow = {
  domain_category_id: DbId;
  domain_id: DbId;
  category_id: DbId;
  is_active: boolean;
  sort_order: number | null;
  source: string | null;
  created_at: Date;
  updated_at: Date;
};

export type CategoryBrandRow = {
  category_brand_id: DbId;
  domain_category_id: DbId;
  brand_id: DbId;
  is_active: boolean;
  sort_order: number | null;
  source: string | null;
  created_at: Date;
  updated_at: Date;
};

export type BrandProductRow = {
  brand_product_id: DbId;
  category_brand_id: DbId;
  product_id: DbId;
  is_active: boolean;
  sort_order: number | null;
  source: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ProductUseContextRow = {
  product_use_context_id: DbId;
  brand_product_id: DbId;
  use_context_id: DbId;
  is_active: boolean;
  sort_order: number | null;
  source: string | null;
  created_at: Date;
  updated_at: Date;
};

export type EntityPathRow = {
  entity_path_id: DbId;
  domain_id: DbId;
  category_id: DbId | null;
  brand_id: DbId | null;
  product_id: DbId | null;
  use_context_id: DbId | null;
  path_type: EntityPathType;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

export type AnalysisRunRow = {
  analysis_run_id: DbId;
  idempotency_key: string;
  anonymous_session_id: DbId | null;
  user_id: DbId | null;
  workspace_id: DbId | null;
  starting_entity_path_id: DbId;
  requested_provider: ProviderName | null;
  requested_model: string | null;
  source: AnalysisRunSource;
  status: AnalysisExecutionStatus;
  request_payload: JsonObject;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type AnalysisRunItemRow = {
  analysis_run_item_id: DbId;
  idempotency_key: string;
  analysis_run_id: DbId;
  entity_path_id: DbId;
  item_ordinal: number;
  status: AnalysisExecutionStatus;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type LlmRunRow = {
  llm_run_id: DbId;
  idempotency_key: string;
  analysis_run_item_id: DbId;
  run_key: string;
  status: AnalysisExecutionStatus;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type PromptJobRow = {
  prompt_job_id: DbId;
  idempotency_key: string;
  llm_run_id: DbId;
  prompt_type: PromptType;
  prompt_version: string;
  status: JobStatus;
  prompt_text: string | null;
  input_payload: JsonObject;
  priority: number;
  attempt_count: number;
  available_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ProviderJobRow = {
  provider_job_id: DbId;
  idempotency_key: string;
  prompt_job_id: DbId;
  provider: ProviderName;
  model: string;
  status: JobStatus;
  request_payload: JsonObject;
  attempt_count: number;
  max_attempts: number;
  available_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

export type ProviderResultRow = {
  provider_result_id: DbId;
  idempotency_key: string;
  provider_job_id: DbId;
  provider: ProviderName;
  status: ProviderResultStatus;
  provider_request_id: string | null;
  model_version: string | null;
  raw_response: string;
  parsed_response: JsonValue | null;
  validation_errors: JsonValue[];
  finish_reason: string | null;
  latency_ms: number;
  received_at: Date;
  created_at: Date;
};

export type BudgetPolicyRow = {
  budget_policy_id: DbId;
  budget_scope: BudgetScope;
  workspace_id: DbId | null;
  provider: ProviderName;
  limit_mode: BudgetLimitMode;
  window_seconds: number;
  token_limit: DbId | null;
  cost_limit_micros: DbId | null;
  currency_code: string;
  is_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export type TokenUsageRow = {
  token_usage_id: DbId;
  idempotency_key: string;
  provider_job_id: DbId;
  usage_kind: TokenUsageKind;
  input_tokens: DbId;
  output_tokens: DbId;
  cached_tokens: DbId;
  reasoning_tokens: DbId;
  total_tokens: DbId;
  cost_micros: DbId | null;
  currency_code: string;
  recorded_at: Date;
  created_at: Date;
};

export type ProviderScoreRow = {
  provider_score_id: DbId;
  idempotency_key: string;
  provider_result_id: DbId;
  scoring_version: string;
  score: NumericString;
  score_components: JsonObject;
  calculated_at: Date;
  created_at: Date;
};

export type ReportRow = {
  report_id: DbId;
  idempotency_key: string;
  analysis_run_id: DbId;
  report_version: string;
  status: ReportStatus;
  report_data: JsonObject;
  rendered_text: string | null;
  generated_at: Date;
  created_at: Date;
};

export type OutboxEventRow = {
  outbox_event_id: DbId;
  event_key: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  payload: JsonObject;
  headers: JsonObject;
  status: OutboxStatus;
  attempt_count: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  published_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

export type FailureRecordRow = {
  failure_record_id: DbId;
  queue_name: string;
  message_id: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  attempt_number: number;
  error_code: string | null;
  error_message: string;
  error_details: JsonObject;
  status: FailureRecordStatus;
  occurred_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type NotificationRow = {
  notification_id: DbId;
  idempotency_key: string;
  user_id: DbId | null;
  workspace_id: DbId | null;
  analysis_run_id: DbId | null;
  failure_record_id: DbId | null;
  is_admin_notification: boolean;
  channel: NotificationChannel;
  status: NotificationStatus;
  payload: JsonObject;
  attempt_count: number;
  available_at: Date;
  sent_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

export type SchedulerJobRow = {
  scheduler_job_id: DbId;
  idempotency_key: string;
  workspace_id: DbId;
  created_by_user_id: DbId;
  starting_entity_path_id: DbId;
  job_name: string;
  schedule_expression: string;
  timezone: string;
  status: SchedulerJobStatus;
  request_payload: JsonObject;
  next_run_at: Date;
  last_enqueued_at: Date | null;
  last_analysis_run_id: DbId | null;
  created_at: Date;
  updated_at: Date;
};
