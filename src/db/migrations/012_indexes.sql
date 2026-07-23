CREATE INDEX user_sessions_user_status_idx
  ON user_sessions (user_id, status);

CREATE INDEX user_sessions_active_expiry_idx
  ON user_sessions (expires_at)
  WHERE status = 'active';

CREATE INDEX anonymous_sessions_active_expiry_idx
  ON anonymous_sessions (expires_at)
  WHERE status = 'active';

CREATE INDEX anonymous_sessions_claimed_idx
  ON anonymous_sessions (claimed_workspace_id, claimed_by_user_id)
  WHERE claimed_workspace_id IS NOT NULL;

CREATE INDEX workspace_members_user_idx
  ON workspace_members (user_id, workspace_id);

CREATE INDEX workspace_role_change_pending_idx
  ON workspace_role_change_requests (workspace_id, created_at)
  WHERE status = 'pending';

CREATE UNIQUE INDEX workspace_role_change_one_pending_idx
  ON workspace_role_change_requests (workspace_id, target_user_id)
  WHERE status = 'pending';

CREATE INDEX entity_paths_domain_idx
  ON entity_paths (domain_id, entity_path_id);

CREATE INDEX entity_paths_domain_category_idx
  ON entity_paths (domain_id, category_id)
  WHERE category_id IS NOT NULL;

CREATE INDEX entity_paths_domain_category_brand_idx
  ON entity_paths (domain_id, category_id, brand_id)
  WHERE brand_id IS NOT NULL;

CREATE INDEX entity_paths_product_idx
  ON entity_paths (product_id, use_context_id)
  WHERE product_id IS NOT NULL;

CREATE INDEX analysis_runs_anonymous_history_idx
  ON analysis_runs (anonymous_session_id, created_at DESC)
  WHERE anonymous_session_id IS NOT NULL;

CREATE INDEX analysis_runs_workspace_history_idx
  ON analysis_runs (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX analysis_runs_user_history_idx
  ON analysis_runs (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX analysis_runs_status_updated_idx
  ON analysis_runs (status, updated_at);

CREATE INDEX analysis_run_items_run_status_idx
  ON analysis_run_items (analysis_run_id, status, item_ordinal);

CREATE INDEX analysis_run_items_status_updated_idx
  ON analysis_run_items (status, updated_at);

CREATE INDEX llm_runs_item_status_idx
  ON llm_runs (analysis_run_item_id, status);

CREATE INDEX llm_runs_status_updated_idx
  ON llm_runs (status, updated_at);

CREATE INDEX prompt_jobs_dispatch_idx
  ON prompt_jobs (status, available_at, priority DESC, prompt_job_id)
  WHERE status IN ('pending', 'queued', 'failed');

CREATE INDEX prompt_jobs_llm_run_idx
  ON prompt_jobs (llm_run_id, prompt_type);

CREATE INDEX provider_jobs_dispatch_idx
  ON provider_jobs (provider, status, available_at, provider_job_id)
  WHERE status IN ('pending', 'queued', 'failed');

CREATE INDEX provider_jobs_prompt_idx
  ON provider_jobs (prompt_job_id, provider);

CREATE UNIQUE INDEX provider_results_provider_request_unique_idx
  ON provider_results (provider, provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE INDEX budget_policies_lookup_idx
  ON budget_policies (budget_scope, workspace_id, provider)
  WHERE is_enabled;

CREATE INDEX token_usage_provider_recorded_idx
  ON token_usage (provider_job_id, recorded_at DESC);

CREATE INDEX provider_scores_result_idx
  ON provider_scores (provider_result_id, calculated_at DESC);

CREATE INDEX reports_run_generated_idx
  ON reports (analysis_run_id, generated_at DESC);

CREATE INDEX outbox_events_publishable_idx
  ON outbox_events (status, available_at, outbox_event_id)
  WHERE status IN ('pending', 'failed');

CREATE INDEX outbox_events_aggregate_idx
  ON outbox_events (aggregate_type, aggregate_id, created_at);

CREATE INDEX outbox_events_published_idx
  ON outbox_events (published_at)
  WHERE status = 'published';

CREATE INDEX failure_records_open_queue_idx
  ON failure_records (queue_name, occurred_at DESC)
  WHERE status IN ('open', 'acknowledged');

CREATE INDEX notifications_delivery_idx
  ON notifications (status, available_at, notification_id)
  WHERE status IN ('pending', 'queued', 'failed');

CREATE INDEX notifications_analysis_run_idx
  ON notifications (analysis_run_id, created_at DESC)
  WHERE analysis_run_id IS NOT NULL;

CREATE INDEX scheduler_jobs_due_idx
  ON scheduler_jobs (next_run_at, scheduler_job_id)
  WHERE status = 'active';

CREATE INDEX scheduler_jobs_workspace_idx
  ON scheduler_jobs (workspace_id, status);
