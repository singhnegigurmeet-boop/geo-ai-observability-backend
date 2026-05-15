ALTER TABLE analysis_runs
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'scheduled', 'retry'));

ALTER TABLE provider_snapshots
  ADD COLUMN IF NOT EXISTS analysis_run_id integer REFERENCES analysis_runs(id) ON DELETE SET NULL;

ALTER TABLE visibility_scores
  ADD COLUMN IF NOT EXISTS analysis_run_id integer REFERENCES analysis_runs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS analysis_diffs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id integer NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  analysis_run_id integer NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  previous_analysis_run_id integer REFERENCES analysis_runs(id) ON DELETE SET NULL,
  diff_type text NOT NULL CHECK (
    diff_type IN (
      'visibility_score_dropped',
      'brand_rank_changed',
      'provider_mention_disappeared',
      'provider_recovered'
    )
  ),
  provider text CHECK (provider IN ('openai', 'gemini', 'claude')),
  old_value jsonb,
  new_value jsonb,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_snapshots_analysis_run_idx
  ON provider_snapshots (analysis_run_id);

CREATE INDEX IF NOT EXISTS visibility_scores_analysis_run_idx
  ON visibility_scores (analysis_run_id);

CREATE INDEX IF NOT EXISTS analysis_diffs_run_idx
  ON analysis_diffs (analysis_run_id);

CREATE INDEX IF NOT EXISTS analysis_diffs_domain_created_idx
  ON analysis_diffs (domain_id, created_at DESC);
