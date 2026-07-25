ALTER TABLE budget_policies
  DROP CONSTRAINT budget_policies_scope_provider_window_unique,
  DROP CONSTRAINT budget_policies_scope_check,
  ADD COLUMN user_id bigint
    REFERENCES users(user_id)
    ON DELETE RESTRICT,
  ADD COLUMN anonymous_session_id bigint
    REFERENCES anonymous_sessions(anonymous_session_id)
    ON DELETE RESTRICT,
  ADD COLUMN analysis_run_id bigint
    REFERENCES analysis_runs(analysis_run_id)
    ON DELETE RESTRICT,
  ADD COLUMN model text;

ALTER TABLE budget_policies
  ADD CONSTRAINT budget_policies_scope_check CHECK (
    (
      budget_scope = 'platform_default'
      AND workspace_id IS NULL
      AND user_id IS NULL
      AND anonymous_session_id IS NULL
      AND analysis_run_id IS NULL
    )
    OR
    (
      budget_scope = 'workspace'
      AND workspace_id IS NOT NULL
      AND user_id IS NULL
      AND anonymous_session_id IS NULL
      AND analysis_run_id IS NULL
    )
    OR
    (
      budget_scope = 'user'
      AND workspace_id IS NULL
      AND user_id IS NOT NULL
      AND anonymous_session_id IS NULL
      AND analysis_run_id IS NULL
    )
    OR
    (
      budget_scope = 'anonymous_session'
      AND workspace_id IS NULL
      AND user_id IS NULL
      AND anonymous_session_id IS NOT NULL
      AND analysis_run_id IS NULL
    )
    OR
    (
      budget_scope = 'analysis_run'
      AND workspace_id IS NULL
      AND user_id IS NULL
      AND anonymous_session_id IS NULL
      AND analysis_run_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT budget_policies_model_not_blank_check CHECK (
    model IS NULL OR length(btrim(model)) > 0
  ),
  ADD CONSTRAINT budget_policies_scope_provider_model_window_unique
    UNIQUE NULLS NOT DISTINCT (
      budget_scope,
      workspace_id,
      user_id,
      anonymous_session_id,
      analysis_run_id,
      provider,
      model,
      window_seconds
    );

CREATE INDEX budget_policies_user_lookup_idx
  ON budget_policies (user_id, provider, model)
  WHERE is_enabled AND user_id IS NOT NULL;

CREATE INDEX budget_policies_anonymous_lookup_idx
  ON budget_policies (anonymous_session_id, provider, model)
  WHERE is_enabled AND anonymous_session_id IS NOT NULL;

CREATE INDEX budget_policies_run_lookup_idx
  ON budget_policies (analysis_run_id, provider, model)
  WHERE is_enabled AND analysis_run_id IS NOT NULL;
