ALTER TABLE public.analysis_runs
  ADD COLUMN requested_provider public.provider_name,
  ADD COLUMN requested_model text;

ALTER TABLE public.analysis_runs
  ADD CONSTRAINT analysis_runs_requested_provider_model_pair_check CHECK (
    (requested_provider IS NULL AND requested_model IS NULL)
    OR
    (
      requested_provider IS NOT NULL
      AND requested_model IS NOT NULL
      AND length(btrim(requested_model)) > 0
    )
  ),
  ADD CONSTRAINT analysis_runs_anonymous_model_selection_check CHECK (
    user_id IS NOT NULL
    OR (requested_provider IS NULL AND requested_model IS NULL)
  ),
  ADD CONSTRAINT analysis_runs_requested_model_allowed_check CHECK (
    requested_provider IS NULL
    OR
    (
      requested_provider = 'mock'
      AND requested_model IN ('mock-fast', 'mock-standard', 'mock-quality')
    )
  );
