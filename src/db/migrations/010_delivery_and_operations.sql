CREATE TABLE outbox_events (
  outbox_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  status outbox_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  published_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_events_key_not_blank_check CHECK (length(btrim(event_key)) > 0),
  CONSTRAINT outbox_events_aggregate_type_not_blank_check CHECK (
    length(btrim(aggregate_type)) > 0
  ),
  CONSTRAINT outbox_events_aggregate_id_not_blank_check CHECK (
    length(btrim(aggregate_id)) > 0
  ),
  CONSTRAINT outbox_events_type_not_blank_check CHECK (
    length(btrim(event_type)) > 0
  ),
  CONSTRAINT outbox_events_version_check CHECK (event_version > 0),
  CONSTRAINT outbox_events_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_events_headers_object_check CHECK (jsonb_typeof(headers) = 'object'),
  CONSTRAINT outbox_events_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT outbox_events_publish_state_check CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  ),
  CONSTRAINT outbox_events_lock_state_check CHECK (
    (locked_at IS NULL AND locked_by IS NULL)
    OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)
  )
);

CREATE TABLE failure_records (
  failure_record_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue_name text NOT NULL,
  message_id text NOT NULL,
  aggregate_type text,
  aggregate_id text,
  attempt_number integer NOT NULL,
  error_code text,
  error_message text NOT NULL,
  error_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status failure_record_status NOT NULL DEFAULT 'open',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT failure_records_queue_not_blank_check CHECK (
    length(btrim(queue_name)) > 0
  ),
  CONSTRAINT failure_records_message_not_blank_check CHECK (
    length(btrim(message_id)) > 0
  ),
  CONSTRAINT failure_records_attempt_check CHECK (
    attempt_number BETWEEN 1 AND 3
  ),
  CONSTRAINT failure_records_error_not_blank_check CHECK (
    length(btrim(error_message)) > 0
  ),
  CONSTRAINT failure_records_details_object_check CHECK (
    jsonb_typeof(error_details) = 'object'
  ),
  CONSTRAINT failure_records_resolution_check CHECK (
    (status = 'open' AND acknowledged_at IS NULL AND resolved_at IS NULL)
    OR
    (
      status = 'acknowledged'
      AND acknowledged_at IS NOT NULL
      AND resolved_at IS NULL
    )
    OR
    (
      status = 'resolved'
      AND acknowledged_at IS NOT NULL
      AND resolved_at IS NOT NULL
    )
  ),
  CONSTRAINT failure_records_message_attempt_unique UNIQUE (
    queue_name,
    message_id,
    attempt_number
  )
);

CREATE TABLE notifications (
  notification_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  user_id bigint REFERENCES users(user_id) ON DELETE RESTRICT,
  workspace_id bigint REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
  analysis_run_id bigint REFERENCES analysis_runs(analysis_run_id) ON DELETE RESTRICT,
  failure_record_id bigint REFERENCES failure_records(failure_record_id) ON DELETE RESTRICT,
  is_admin_notification boolean NOT NULL DEFAULT false,
  channel notification_channel NOT NULL,
  status notification_status NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT notifications_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT notifications_attempt_count_check CHECK (
    attempt_count BETWEEN 0 AND 3
  ),
  CONSTRAINT notifications_recipient_check CHECK (
    (
      is_admin_notification
      AND user_id IS NULL
      AND workspace_id IS NULL
    )
    OR
    (
      NOT is_admin_notification
      AND (user_id IS NOT NULL OR workspace_id IS NOT NULL)
    )
  ),
  CONSTRAINT notifications_sent_state_check CHECK (
    (status = 'sent' AND sent_at IS NOT NULL)
    OR (status <> 'sent' AND sent_at IS NULL)
  )
);

CREATE TABLE scheduler_jobs (
  scheduler_job_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  workspace_id bigint NOT NULL,
  created_by_user_id bigint NOT NULL,
  starting_entity_path_id bigint NOT NULL REFERENCES entity_paths(entity_path_id) ON DELETE RESTRICT,
  job_name text NOT NULL,
  schedule_expression text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  status scheduler_job_status NOT NULL DEFAULT 'active',
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_run_at timestamptz NOT NULL,
  last_enqueued_at timestamptz,
  last_analysis_run_id bigint REFERENCES analysis_runs(analysis_run_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduler_jobs_workspace_member_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES workspace_members(workspace_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT scheduler_jobs_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT scheduler_jobs_name_not_blank_check CHECK (
    length(btrim(job_name)) > 0
  ),
  CONSTRAINT scheduler_jobs_expression_not_blank_check CHECK (
    length(btrim(schedule_expression)) > 0
  ),
  CONSTRAINT scheduler_jobs_timezone_not_blank_check CHECK (
    length(btrim(timezone)) > 0
  ),
  CONSTRAINT scheduler_jobs_payload_object_check CHECK (
    jsonb_typeof(request_payload) = 'object'
  ),
  CONSTRAINT scheduler_jobs_workspace_name_unique UNIQUE (workspace_id, job_name)
);
