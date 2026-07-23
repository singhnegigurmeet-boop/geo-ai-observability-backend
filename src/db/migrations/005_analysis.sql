CREATE TABLE analysis_runs (
  analysis_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  anonymous_session_id bigint REFERENCES anonymous_sessions(anonymous_session_id) ON DELETE RESTRICT,
  user_id bigint REFERENCES users(user_id) ON DELETE RESTRICT,
  workspace_id bigint REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
  starting_entity_path_id bigint NOT NULL REFERENCES entity_paths(entity_path_id) ON DELETE RESTRICT,
  source analysis_run_source NOT NULL DEFAULT 'manual',
  status analysis_execution_status NOT NULL DEFAULT 'queued',
  request_payload jsonb NOT NULL,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_runs_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT analysis_runs_request_payload_object_check CHECK (
    jsonb_typeof(request_payload) = 'object'
  ),
  CONSTRAINT analysis_runs_ownership_check CHECK (
    (
      anonymous_session_id IS NOT NULL
      AND user_id IS NULL
      AND workspace_id IS NULL
    )
    OR
    (
      user_id IS NOT NULL
      AND workspace_id IS NOT NULL
    )
  ),
  CONSTRAINT analysis_runs_workspace_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members(workspace_id, user_id)
    MATCH FULL
    ON DELETE RESTRICT,
  CONSTRAINT analysis_runs_completion_check CHECK (
    (
      status IN ('completed', 'partial_success', 'failed', 'cancelled')
      AND completed_at IS NOT NULL
    )
    OR
    (
      status NOT IN ('completed', 'partial_success', 'failed', 'cancelled')
      AND completed_at IS NULL
    )
  )
);

CREATE TABLE analysis_run_items (
  analysis_run_item_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  analysis_run_id bigint NOT NULL REFERENCES analysis_runs(analysis_run_id) ON DELETE RESTRICT,
  entity_path_id bigint NOT NULL REFERENCES entity_paths(entity_path_id) ON DELETE RESTRICT,
  item_ordinal integer NOT NULL,
  status analysis_execution_status NOT NULL DEFAULT 'queued',
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_run_items_idempotency_not_blank_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT analysis_run_items_ordinal_check CHECK (item_ordinal >= 0),
  CONSTRAINT analysis_run_items_run_path_unique UNIQUE (
    analysis_run_id,
    entity_path_id
  ),
  CONSTRAINT analysis_run_items_run_ordinal_unique UNIQUE (
    analysis_run_id,
    item_ordinal
  ),
  CONSTRAINT analysis_run_items_completion_check CHECK (
    (
      status IN ('completed', 'partial_success', 'failed', 'cancelled')
      AND completed_at IS NOT NULL
    )
    OR
    (
      status NOT IN ('completed', 'partial_success', 'failed', 'cancelled')
      AND completed_at IS NULL
    )
  )
);
