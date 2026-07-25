ALTER TABLE public.analysis_runs
  DROP CONSTRAINT analysis_runs_requested_model_allowed_check,
  ADD CONSTRAINT analysis_runs_requested_model_allowed_check CHECK (
    requested_provider IS NULL
    OR
    (requested_provider = 'mock' AND requested_model IN (
      'mock-fast', 'mock-standard', 'mock-quality'
    ))
    OR
    (requested_provider = 'openai' AND requested_model = 'gpt-4o-mini')
    OR
    (requested_provider = 'gemini' AND requested_model = 'gemini-1.5-flash')
    OR
    (requested_provider = 'claude' AND requested_model = 'claude-3-5-sonnet')
  );
