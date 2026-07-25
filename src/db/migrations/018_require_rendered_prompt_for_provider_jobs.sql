CREATE FUNCTION public.enforce_provider_job_rendered_prompt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.prompt_jobs
    WHERE prompt_job_id = NEW.prompt_job_id
      AND prompt_text IS NOT NULL
      AND length(btrim(prompt_text)) > 0
  ) THEN
    RAISE EXCEPTION 'provider_jobs requires a rendered nonblank prompt'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_jobs_require_rendered_prompt_trigger
BEFORE INSERT OR UPDATE OF prompt_job_id ON public.provider_jobs
FOR EACH ROW
EXECUTE FUNCTION public.enforce_provider_job_rendered_prompt();
