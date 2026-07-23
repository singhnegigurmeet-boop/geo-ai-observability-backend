CREATE FUNCTION preserve_analysis_run_anonymous_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.anonymous_session_id IS NOT NULL
     AND NEW.anonymous_session_id IS DISTINCT FROM OLD.anonymous_session_id THEN
    RAISE EXCEPTION 'analysis_runs.anonymous_session_id is immutable once set'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_runs_preserve_anonymous_origin_trigger
BEFORE UPDATE OF anonymous_session_id ON analysis_runs
FOR EACH ROW
EXECUTE FUNCTION preserve_analysis_run_anonymous_origin();

CREATE FUNCTION reject_immutable_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER provider_results_immutable_trigger
BEFORE UPDATE OR DELETE ON provider_results
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_evidence_mutation();

CREATE TRIGGER token_usage_immutable_trigger
BEFORE UPDATE OR DELETE ON token_usage
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_evidence_mutation();

CREATE TRIGGER provider_scores_immutable_trigger
BEFORE UPDATE OR DELETE ON provider_scores
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_evidence_mutation();

CREATE TRIGGER reports_immutable_trigger
BEFORE UPDATE OR DELETE ON reports
FOR EACH ROW
EXECUTE FUNCTION reject_immutable_evidence_mutation();
