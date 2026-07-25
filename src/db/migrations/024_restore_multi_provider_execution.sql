CREATE TABLE analysis_run_provider_models (
  analysis_run_provider_model_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  analysis_run_id bigint NOT NULL
    REFERENCES analysis_runs(analysis_run_id)
    ON DELETE RESTRICT,
  provider provider_name NOT NULL,
  model text NOT NULL,
  ordinal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_run_provider_models_model_not_blank_check CHECK (
    length(btrim(model)) > 0
  ),
  CONSTRAINT analysis_run_provider_models_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT analysis_run_provider_models_run_provider_model_unique UNIQUE (
    analysis_run_id,
    provider,
    model
  ),
  CONSTRAINT analysis_run_provider_models_run_ordinal_unique UNIQUE (
    analysis_run_id,
    ordinal
  )
);

INSERT INTO analysis_run_provider_models (
  analysis_run_id,
  provider,
  model,
  ordinal
)
SELECT
  analysis_run_id,
  COALESCE(
    requested_provider,
    CASE WHEN user_id IS NULL THEN 'mock'::provider_name ELSE 'mock'::provider_name END
  ),
  COALESCE(
    requested_model,
    CASE WHEN user_id IS NULL THEN 'mock-fast' ELSE 'mock-standard' END
  ),
  0
FROM analysis_runs;

CREATE INDEX analysis_run_provider_models_run_order_idx
  ON analysis_run_provider_models (analysis_run_id, ordinal);

CREATE TRIGGER analysis_run_provider_models_immutable_trigger
BEFORE UPDATE OR DELETE ON analysis_run_provider_models
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_evidence_mutation();

ALTER TABLE reports
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT reports_revision_positive_check CHECK (revision > 0),
  DROP CONSTRAINT reports_run_version_unique,
  ADD CONSTRAINT reports_run_version_revision_unique UNIQUE (
    analysis_run_id,
    report_version,
    revision
  );

CREATE INDEX reports_latest_revision_idx
  ON reports (analysis_run_id, report_version, revision DESC);

CREATE OR REPLACE FUNCTION public.notify_report_ready()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_record public.analysis_runs%ROWTYPE;
BEGIN
  SELECT * INTO run_record
  FROM public.analysis_runs
  WHERE analysis_run_id = NEW.analysis_run_id;

  IF run_record.user_id IS NOT NULL AND run_record.workspace_id IS NOT NULL THEN
    PERFORM public.create_notification_outbox(
      'notification:report_ready:' || NEW.report_id,
      run_record.user_id,
      run_record.workspace_id,
      NEW.analysis_run_id,
      NULL,
      false,
      jsonb_build_object(
        'type', 'report_ready',
        'analysisRunId', NEW.analysis_run_id::text,
        'reportId', NEW.report_id::text,
        'reportVersion', NEW.report_version,
        'revision', NEW.revision,
        'reportStatus', NEW.status::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.notify_analysis_cancelled()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'cancelled'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.user_id IS NOT NULL
     AND NEW.workspace_id IS NOT NULL THEN
    PERFORM public.create_notification_outbox(
      'notification:analysis_cancelled:' || NEW.analysis_run_id,
      NEW.user_id,
      NEW.workspace_id,
      NEW.analysis_run_id,
      NULL,
      false,
      jsonb_build_object(
        'type', 'analysis_cancelled',
        'analysisRunId', NEW.analysis_run_id::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_runs_notify_cancelled_trigger
AFTER UPDATE OF status ON analysis_runs
FOR EACH ROW
EXECUTE FUNCTION public.notify_analysis_cancelled();
