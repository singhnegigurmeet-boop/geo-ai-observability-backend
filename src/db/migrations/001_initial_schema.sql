CREATE TABLE IF NOT EXISTS domains (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_analysis (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  llm_name text NOT NULL CHECK (llm_name IN ('openai', 'gemini', 'claude')),
  top_k integer NOT NULL CHECK (top_k IN (5, 10, 15, 50, 100)),
  rank_position integer,
  mention_count integer NOT NULL DEFAULT 0,
  score numeric(5, 2) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  error_message text,
  last_run timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id, llm_name, top_k)
);

CREATE TABLE IF NOT EXISTS provider_snapshots (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  llm_name text NOT NULL CHECK (llm_name IN ('openai', 'gemini', 'claude')),
  top_k integer NOT NULL CHECK (top_k IN (5, 10, 15, 50, 100)),
  rank_position integer,
  mention_count integer NOT NULL DEFAULT 0,
  score numeric(5, 2) NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visibility_scores (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  openai_score numeric(5, 2) NOT NULL DEFAULT 0,
  gemini_score numeric(5, 2) NOT NULL DEFAULT 0,
  claude_score numeric(5, 2) NOT NULL DEFAULT 0,
  coverage_score numeric(5, 2) NOT NULL DEFAULT 0,
  consistency_score numeric(5, 2) NOT NULL DEFAULT 0,
  mention_frequency_score numeric(5, 2) NOT NULL DEFAULT 0,
  overall_geo_score numeric(5, 2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_snapshots_domain_created_idx
  ON provider_snapshots (domain_id, created_at DESC);

CREATE INDEX IF NOT EXISTS visibility_scores_domain_created_idx
  ON visibility_scores (domain_id, created_at DESC);
