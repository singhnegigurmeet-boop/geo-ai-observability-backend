CREATE TABLE IF NOT EXISTS domains (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  bullmq_job_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'partial_success', 'failed')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scheduled', 'retry')),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_analysis (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  llm_name text NOT NULL CHECK (llm_name IN ('openai', 'gemini', 'claude')),
  top_k integer NOT NULL CHECK (top_k IN (5, 10, 15, 50, 100)),
  rank_position integer,
  mention_count integer NOT NULL DEFAULT 0,
  score numeric(5, 2) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  error_message text,
  last_run timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id, llm_name, top_k)
);

CREATE TABLE IF NOT EXISTS provider_snapshots (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  analysis_run_id integer REFERENCES analysis_runs(id) ON DELETE SET NULL,
  llm_name text NOT NULL CHECK (llm_name IN ('openai', 'gemini', 'claude')),
  top_k integer NOT NULL CHECK (top_k IN (5, 10, 15, 50, 100)),
  rank_position integer,
  mention_count integer NOT NULL DEFAULT 0,
  score numeric(5, 2) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visibility_scores (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  analysis_run_id integer REFERENCES analysis_runs(id) ON DELETE SET NULL,
  openai_score numeric(5, 2) NOT NULL DEFAULT 0,
  gemini_score numeric(5, 2) NOT NULL DEFAULT 0,
  claude_score numeric(5, 2) NOT NULL DEFAULT 0,
  coverage_score numeric(5, 2) NOT NULL DEFAULT 0,
  consistency_score numeric(5, 2) NOT NULL DEFAULT 0,
  mention_frequency_score numeric(5, 2) NOT NULL DEFAULT 0,
  overall_geo_score numeric(5, 2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_diffs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  analysis_run_id integer NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  previous_analysis_run_id integer REFERENCES analysis_runs(id) ON DELETE SET NULL,
  diff_type text NOT NULL CHECK (
    diff_type IN (
      'visibility_score_dropped',
      'brand_rank_changed',
      'provider_mention_disappeared',
      'provider_recovered'
    )
  ),
  provider text CHECK (provider IN ('openai', 'gemini', 'claude')),
  old_value jsonb,
  new_value jsonb,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_schedules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  cadence text NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('weekly')),
  enabled boolean NOT NULL DEFAULT true,
  last_enqueued_at timestamptz,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  analysis_diff_id integer NOT NULL REFERENCES analysis_diffs(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'log' CHECK (channel IN ('log')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  payload jsonb NOT NULL,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS analysis_runs_domain_created_idx
  ON analysis_runs (domain_id, created_at DESC);

CREATE INDEX IF NOT EXISTS analysis_runs_status_idx
  ON analysis_runs (status);

CREATE INDEX IF NOT EXISTS provider_snapshots_domain_created_idx
  ON provider_snapshots (domain_id, created_at DESC);

CREATE INDEX IF NOT EXISTS provider_snapshots_analysis_run_idx
  ON provider_snapshots (analysis_run_id);

CREATE INDEX IF NOT EXISTS visibility_scores_domain_created_idx
  ON visibility_scores (domain_id, created_at DESC);

CREATE INDEX IF NOT EXISTS visibility_scores_analysis_run_idx
  ON visibility_scores (analysis_run_id);

CREATE INDEX IF NOT EXISTS analysis_diffs_run_idx
  ON analysis_diffs (analysis_run_id);

CREATE INDEX IF NOT EXISTS analysis_diffs_domain_created_idx
  ON analysis_diffs (domain_id, created_at DESC);

CREATE INDEX IF NOT EXISTS domain_schedules_due_idx
  ON domain_schedules (enabled, next_run_at);

CREATE INDEX IF NOT EXISTS notifications_status_created_idx
  ON notifications (status, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_diff_idx
  ON notifications (analysis_diff_id);
