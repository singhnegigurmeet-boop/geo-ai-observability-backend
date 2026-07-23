CREATE TABLE provider_jobs (
  provider_job_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  prompt_job_id bigint NOT NULL REFERENCES prompt_jobs(prompt_job_id) ON DELETE RESTRICT,
  provider provider_name NOT NULL,
  model text NOT NULL,
  status job_status NOT NULL DEFAULT 'pending',
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_jobs_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT provider_jobs_model_not_blank_check CHECK (length(btrim(model)) > 0),
  CONSTRAINT provider_jobs_request_payload_object_check CHECK (
    jsonb_typeof(request_payload) = 'object'
  ),
  CONSTRAINT provider_jobs_attempts_check CHECK (
    attempt_count >= 0
    AND max_attempts = 3
    AND attempt_count <= max_attempts
  ),
  CONSTRAINT provider_jobs_prompt_provider_model_unique UNIQUE (
    prompt_job_id,
    provider,
    model
  ),
  CONSTRAINT provider_jobs_id_provider_unique UNIQUE (provider_job_id, provider)
);

CREATE TABLE provider_results (
  provider_result_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  provider_job_id bigint NOT NULL UNIQUE,
  provider provider_name NOT NULL,
  status provider_result_status NOT NULL,
  provider_request_id text,
  model_version text,
  raw_response text NOT NULL,
  parsed_response jsonb,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  finish_reason text,
  latency_ms integer NOT NULL,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_results_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT provider_results_raw_response_not_blank_check CHECK (
    length(raw_response) > 0
  ),
  CONSTRAINT provider_results_validation_errors_array_check CHECK (
    jsonb_typeof(validation_errors) = 'array'
  ),
  CONSTRAINT provider_results_latency_check CHECK (latency_ms >= 0),
  CONSTRAINT provider_results_job_provider_fk
    FOREIGN KEY (provider_job_id, provider)
    REFERENCES provider_jobs(provider_job_id, provider)
    ON DELETE RESTRICT,
  CONSTRAINT provider_results_validation_state_check CHECK (
    (status = 'valid' AND parsed_response IS NOT NULL AND validation_errors = '[]'::jsonb)
    OR
    (status = 'invalid' AND validation_errors <> '[]'::jsonb)
  )
);
