CREATE TABLE provider_scores (
  provider_score_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  provider_result_id bigint NOT NULL
    REFERENCES provider_results(provider_result_id)
    ON DELETE RESTRICT,
  scoring_version text NOT NULL,
  score numeric(7, 4) NOT NULL,
  score_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_scores_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT provider_scores_version_not_blank_check CHECK (
    length(btrim(scoring_version)) > 0
  ),
  CONSTRAINT provider_scores_range_check CHECK (score >= 0 AND score <= 100),
  CONSTRAINT provider_scores_components_object_check CHECK (
    jsonb_typeof(score_components) = 'object'
  ),
  CONSTRAINT provider_scores_result_version_unique UNIQUE (
    provider_result_id,
    scoring_version
  )
);

CREATE TABLE reports (
  report_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  analysis_run_id bigint NOT NULL REFERENCES analysis_runs(analysis_run_id) ON DELETE RESTRICT,
  report_version text NOT NULL,
  status report_status NOT NULL,
  report_data jsonb NOT NULL,
  rendered_text text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT reports_version_not_blank_check CHECK (
    length(btrim(report_version)) > 0
  ),
  CONSTRAINT reports_data_object_check CHECK (jsonb_typeof(report_data) = 'object'),
  CONSTRAINT reports_run_version_unique UNIQUE (analysis_run_id, report_version)
);
