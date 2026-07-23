CREATE TYPE user_status AS ENUM (
  'active',
  'disabled',
  'deleted'
);

CREATE TYPE session_status AS ENUM (
  'active',
  'revoked',
  'expired'
);

CREATE TYPE workspace_role AS ENUM (
  'owner',
  'admin',
  'member',
  'viewer'
);

CREATE TYPE workspace_role_change_status AS ENUM (
  'pending',
  'approved',
  'rejected',
  'cancelled'
);

CREATE TYPE entity_path_type AS ENUM (
  'domain',
  'category',
  'brand',
  'product',
  'use_context'
);

CREATE TYPE analysis_run_source AS ENUM (
  'manual',
  'scheduled'
);

CREATE TYPE analysis_execution_status AS ENUM (
  'queued',
  'processing',
  'paused_budget',
  'completed',
  'partial_success',
  'failed',
  'cancelled'
);

CREATE TYPE prompt_type AS ENUM (
  'competitor',
  'ranking',
  'visibility',
  'price_range',
  'pros_cons'
);

CREATE TYPE job_status AS ENUM (
  'pending',
  'queued',
  'processing',
  'paused_budget',
  'succeeded',
  'failed',
  'cancelled'
);

CREATE TYPE provider_name AS ENUM (
  'mock',
  'openai',
  'gemini',
  'claude'
);

CREATE TYPE provider_result_status AS ENUM (
  'valid',
  'invalid'
);

CREATE TYPE budget_scope AS ENUM (
  'platform_default',
  'workspace'
);

CREATE TYPE budget_limit_mode AS ENUM (
  'hard',
  'soft'
);

CREATE TYPE token_usage_kind AS ENUM (
  'estimated',
  'actual'
);

CREATE TYPE report_status AS ENUM (
  'completed',
  'partial',
  'failed'
);

CREATE TYPE outbox_status AS ENUM (
  'pending',
  'publishing',
  'published',
  'failed'
);

CREATE TYPE failure_record_status AS ENUM (
  'open',
  'acknowledged',
  'resolved'
);

CREATE TYPE notification_status AS ENUM (
  'pending',
  'queued',
  'sent',
  'failed',
  'cancelled'
);

CREATE TYPE notification_channel AS ENUM (
  'internal',
  'email',
  'webhook'
);

CREATE TYPE scheduler_job_status AS ENUM (
  'active',
  'paused',
  'disabled'
);
