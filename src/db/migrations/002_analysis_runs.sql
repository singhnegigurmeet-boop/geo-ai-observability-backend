CREATE TABLE IF NOT EXISTS analysis_runs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  bullmq_job_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'partial_success', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_runs_domain_created_idx
  ON analysis_runs (domain_id, created_at DESC);

CREATE INDEX IF NOT EXISTS analysis_runs_status_idx
  ON analysis_runs (status);
