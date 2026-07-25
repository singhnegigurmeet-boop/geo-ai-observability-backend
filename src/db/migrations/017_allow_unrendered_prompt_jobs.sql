ALTER TABLE prompt_jobs
  ALTER COLUMN prompt_text DROP NOT NULL;

ALTER TABLE prompt_jobs
  DROP CONSTRAINT prompt_jobs_text_not_blank_check;

ALTER TABLE prompt_jobs
  ADD CONSTRAINT prompt_jobs_text_null_or_not_blank_check CHECK (
    prompt_text IS NULL
    OR length(btrim(prompt_text)) > 0
  );
