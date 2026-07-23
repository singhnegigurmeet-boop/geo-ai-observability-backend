CREATE TABLE users (
  user_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  password_hash text,
  display_name text,
  status user_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT users_email_not_blank_check CHECK (length(btrim(email)) > 0),
  CONSTRAINT users_email_normalized_check CHECK (email = lower(btrim(email))),
  CONSTRAINT users_deleted_state_check CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL)
    OR (status <> 'deleted' AND deleted_at IS NULL)
  )
);

CREATE UNIQUE INDEX users_email_unique_idx
  ON users (lower(email));

CREATE TABLE user_sessions (
  user_session_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  status session_status NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  client_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_sessions_token_hash_not_blank_check CHECK (length(btrim(token_hash)) > 0),
  CONSTRAINT user_sessions_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT user_sessions_revocation_check CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL)
    OR status <> 'revoked'
  ),
  CONSTRAINT user_sessions_client_metadata_object_check CHECK (
    jsonb_typeof(client_metadata) = 'object'
  )
);

CREATE TABLE anonymous_sessions (
  anonymous_session_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  status session_status NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  claimed_by_user_id bigint REFERENCES users(user_id) ON DELETE RESTRICT,
  claimed_workspace_id bigint,
  claimed_at timestamptz,
  client_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anonymous_sessions_token_hash_not_blank_check CHECK (
    length(btrim(token_hash)) > 0
  ),
  CONSTRAINT anonymous_sessions_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT anonymous_sessions_client_metadata_object_check CHECK (
    jsonb_typeof(client_metadata) = 'object'
  )
);
