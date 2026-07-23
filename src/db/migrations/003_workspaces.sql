CREATE TABLE workspaces (
  workspace_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_name text NOT NULL,
  created_by_user_id bigint NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT workspaces_name_not_blank_check CHECK (length(btrim(workspace_name)) > 0)
);

CREATE TABLE workspace_members (
  workspace_id bigint NOT NULL REFERENCES workspaces(workspace_id) ON DELETE RESTRICT,
  user_id bigint NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  role workspace_role NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_role_change_requests (
  workspace_role_change_request_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL,
  target_user_id bigint NOT NULL,
  requested_role workspace_role NOT NULL,
  requested_by_user_id bigint NOT NULL,
  reviewed_by_user_id bigint,
  status workspace_role_change_status NOT NULL DEFAULT 'pending',
  request_reason text,
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_role_change_target_member_fk
    FOREIGN KEY (workspace_id, target_user_id)
    REFERENCES workspace_members(workspace_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_role_change_requester_member_fk
    FOREIGN KEY (workspace_id, requested_by_user_id)
    REFERENCES workspace_members(workspace_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_role_change_reviewer_member_fk
    FOREIGN KEY (workspace_id, reviewed_by_user_id)
    REFERENCES workspace_members(workspace_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT workspace_role_change_review_check CHECK (
    (status = 'pending' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
    OR
    (status <> 'pending' AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

ALTER TABLE anonymous_sessions
  ADD CONSTRAINT anonymous_sessions_claimed_workspace_fk
    FOREIGN KEY (claimed_workspace_id)
    REFERENCES workspaces(workspace_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT anonymous_sessions_claimed_membership_fk
    FOREIGN KEY (claimed_workspace_id, claimed_by_user_id)
    REFERENCES workspace_members(workspace_id, user_id)
    MATCH FULL
    ON DELETE RESTRICT,
  ADD CONSTRAINT anonymous_sessions_claim_state_check CHECK (
    (
      claimed_by_user_id IS NULL
      AND claimed_workspace_id IS NULL
      AND claimed_at IS NULL
    )
    OR
    (
      claimed_by_user_id IS NOT NULL
      AND claimed_workspace_id IS NOT NULL
      AND claimed_at IS NOT NULL
    )
  );
