CREATE FUNCTION public.create_notification_outbox(
  notification_key text,
  notification_user_id bigint,
  notification_workspace_id bigint,
  notification_analysis_run_id bigint,
  notification_failure_record_id bigint,
  admin_notification boolean,
  notification_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  created_notification_id bigint;
BEGIN
  INSERT INTO public.notifications (
    idempotency_key,
    user_id,
    workspace_id,
    analysis_run_id,
    failure_record_id,
    is_admin_notification,
    channel,
    payload
  )
  VALUES (
    notification_key,
    notification_user_id,
    notification_workspace_id,
    notification_analysis_run_id,
    notification_failure_record_id,
    admin_notification,
    'internal',
    notification_payload
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING notification_id INTO created_notification_id;

  IF created_notification_id IS NOT NULL THEN
    INSERT INTO public.outbox_events (
      event_key,
      aggregate_type,
      aggregate_id,
      event_type,
      event_version,
      payload,
      headers
    )
    VALUES (
      'notification.created:' || created_notification_id,
      'notification',
      created_notification_id::text,
      'notification.created',
      1,
      jsonb_build_object(
        'notificationId', created_notification_id::text,
        'analysisRunId', notification_analysis_run_id::text,
        'failureRecordId', notification_failure_record_id::text,
        'isAdmin', admin_notification
      ),
      jsonb_build_object('queueName', 'notification_queue')
    )
    ON CONFLICT (event_key) DO NOTHING;
  END IF;
END;
$$;

CREATE FUNCTION public.notify_report_ready()
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
      'notification:report_ready:' || NEW.analysis_run_id,
      run_record.user_id,
      run_record.workspace_id,
      NEW.analysis_run_id,
      NULL,
      false,
      jsonb_build_object(
        'type', 'report_ready',
        'analysisRunId', NEW.analysis_run_id::text,
        'reportId', NEW.report_id::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reports_notify_ready_trigger
AFTER INSERT ON public.reports
FOR EACH ROW
EXECUTE FUNCTION public.notify_report_ready();

CREATE FUNCTION public.notify_budget_paused()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'paused_budget'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.user_id IS NOT NULL
     AND NEW.workspace_id IS NOT NULL THEN
    PERFORM public.create_notification_outbox(
      'notification:budget_paused:' || NEW.analysis_run_id,
      NEW.user_id,
      NEW.workspace_id,
      NEW.analysis_run_id,
      NULL,
      false,
      jsonb_build_object(
        'type', 'budget_paused',
        'analysisRunId', NEW.analysis_run_id::text
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER analysis_runs_notify_budget_paused_trigger
AFTER UPDATE OF status ON public.analysis_runs
FOR EACH ROW
EXECUTE FUNCTION public.notify_budget_paused();

CREATE FUNCTION public.notify_terminal_failure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.attempt_number = 3
     OR NEW.error_details ->> 'permanent' = 'true' THEN
    PERFORM public.create_notification_outbox(
      'notification:technical_failure:' || NEW.failure_record_id,
      NULL,
      NULL,
      NULL,
      NEW.failure_record_id,
      true,
      jsonb_build_object(
        'type', 'technical_failure',
        'failureRecordId', NEW.failure_record_id::text,
        'queueName', NEW.queue_name,
        'errorCode', NEW.error_code
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER failure_records_notify_terminal_trigger
AFTER INSERT ON public.failure_records
FOR EACH ROW
EXECUTE FUNCTION public.notify_terminal_failure();
