DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM analysis_runs AS analysis_run
    JOIN anonymous_sessions AS anonymous_session
      ON anonymous_session.anonymous_session_id = analysis_run.anonymous_session_id
    WHERE analysis_run.user_id IS NOT NULL
      AND (
        anonymous_session.claimed_by_user_id IS DISTINCT FROM analysis_run.user_id
        OR anonymous_session.claimed_workspace_id IS DISTINCT FROM analysis_run.workspace_id
        OR anonymous_session.claimed_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION
      'cannot enforce claimed-run ownership while inconsistent claimed runs exist';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION preserve_analysis_run_anonymous_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.anonymous_session_id IS DISTINCT FROM OLD.anonymous_session_id THEN
    RAISE EXCEPTION 'analysis_runs.anonymous_session_id is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION preserve_anonymous_session_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.claimed_by_user_id IS NOT NULL
     AND (
       NEW.claimed_by_user_id IS DISTINCT FROM OLD.claimed_by_user_id
       OR NEW.claimed_workspace_id IS DISTINCT FROM OLD.claimed_workspace_id
       OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     ) THEN
    RAISE EXCEPTION 'anonymous session claim is immutable once set'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER anonymous_sessions_preserve_claim_trigger
BEFORE UPDATE OF claimed_by_user_id, claimed_workspace_id, claimed_at ON anonymous_sessions
FOR EACH ROW
EXECUTE FUNCTION preserve_anonymous_session_claim();

CREATE FUNCTION validate_analysis_run_anonymous_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.anonymous_session_id IS NOT NULL AND NEW.user_id IS NOT NULL THEN
    PERFORM 1
    FROM anonymous_sessions
    WHERE anonymous_session_id = NEW.anonymous_session_id
      AND claimed_by_user_id = NEW.user_id
      AND claimed_workspace_id = NEW.workspace_id
      AND claimed_at IS NOT NULL
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'claimed analysis run ownership must match its anonymous session claim'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_runs_validate_anonymous_claim_trigger
BEFORE INSERT OR UPDATE OF anonymous_session_id, user_id, workspace_id ON analysis_runs
FOR EACH ROW
EXECUTE FUNCTION validate_analysis_run_anonymous_claim();
