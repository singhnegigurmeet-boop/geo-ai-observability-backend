CREATE TABLE budget_policies (
  budget_policy_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  budget_scope budget_scope NOT NULL,
  workspace_id bigint REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
  provider provider_name NOT NULL,
  limit_mode budget_limit_mode NOT NULL,
  window_seconds integer NOT NULL,
  token_limit bigint,
  cost_limit_micros bigint,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_policies_scope_check CHECK (
    (budget_scope = 'platform_default' AND workspace_id IS NULL)
    OR
    (budget_scope = 'workspace' AND workspace_id IS NOT NULL)
  ),
  CONSTRAINT budget_policies_window_check CHECK (window_seconds > 0),
  CONSTRAINT budget_policies_limit_check CHECK (
    (token_limit IS NOT NULL OR cost_limit_micros IS NOT NULL)
    AND (token_limit IS NULL OR token_limit > 0)
    AND (cost_limit_micros IS NULL OR cost_limit_micros > 0)
  ),
  CONSTRAINT budget_policies_currency_check CHECK (
    currency_code = upper(currency_code)
  ),
  CONSTRAINT budget_policies_scope_provider_window_unique
    UNIQUE NULLS NOT DISTINCT (
      budget_scope,
      workspace_id,
      provider,
      window_seconds
    )
);

CREATE TABLE token_usage (
  token_usage_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  provider_job_id bigint NOT NULL REFERENCES provider_jobs(provider_job_id) ON DELETE RESTRICT,
  usage_kind token_usage_kind NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cached_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
  cost_micros bigint,
  currency_code char(3) NOT NULL DEFAULT 'USD',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT token_usage_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT token_usage_nonnegative_check CHECK (
    input_tokens >= 0
    AND output_tokens >= 0
    AND cached_tokens >= 0
    AND reasoning_tokens >= 0
    AND (cost_micros IS NULL OR cost_micros >= 0)
  ),
  CONSTRAINT token_usage_component_bounds_check CHECK (
    cached_tokens <= input_tokens
    AND reasoning_tokens <= output_tokens
  ),
  CONSTRAINT token_usage_currency_check CHECK (currency_code = upper(currency_code)),
  CONSTRAINT token_usage_provider_kind_unique UNIQUE (provider_job_id, usage_kind)
);
