CREATE TABLE llm_runs (
  llm_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  analysis_run_item_id bigint NOT NULL
    REFERENCES analysis_run_items(analysis_run_item_id)
    ON DELETE RESTRICT,
  run_key text NOT NULL DEFAULT 'primary',
  status analysis_execution_status NOT NULL DEFAULT 'queued',
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_runs_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT llm_runs_run_key_not_blank_check CHECK (length(btrim(run_key)) > 0),
  CONSTRAINT llm_runs_item_key_unique UNIQUE (analysis_run_item_id, run_key),
  CONSTRAINT llm_runs_completion_check CHECK (
    (
      status IN ('completed', 'partial_success', 'failed', 'cancelled')
      AND completed_at IS NOT NULL
    )
    OR
    (
      status NOT IN ('completed', 'partial_success', 'failed', 'cancelled')
      AND completed_at IS NULL
    )
  )
);

CREATE TABLE prompt_jobs (
  prompt_job_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  llm_run_id bigint NOT NULL REFERENCES llm_runs(llm_run_id) ON DELETE RESTRICT,
  prompt_type prompt_type NOT NULL,
  prompt_version text NOT NULL,
  status job_status NOT NULL DEFAULT 'pending',
  prompt_text text NOT NULL,
  input_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority smallint NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_jobs_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT prompt_jobs_version_not_blank_check CHECK (
    length(btrim(prompt_version)) > 0
  ),
  CONSTRAINT prompt_jobs_text_not_blank_check CHECK (length(btrim(prompt_text)) > 0),
  CONSTRAINT prompt_jobs_input_payload_object_check CHECK (
    jsonb_typeof(input_payload) = 'object'
  ),
  CONSTRAINT prompt_jobs_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT prompt_jobs_llm_type_version_unique UNIQUE (
    llm_run_id,
    prompt_type,
    prompt_version
  )
);
