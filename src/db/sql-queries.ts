export const SQL_QUERIES = {
  migrations: {
    createSchemaMigrationsTable: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `,
    insertSchemaMigration: "INSERT INTO schema_migrations (filename) VALUES ($1)",
    verifyRequiredTables: `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `
  },
  domains: {
    upsertDomain: `
      INSERT INTO domains (domain)
      VALUES ($1)
      ON CONFLICT (domain)
      DO UPDATE SET updated_at = now()
      RETURNING id, domain, created_at, updated_at
    `,
    findById: "SELECT * FROM domains WHERE id = $1",
    findByName: "SELECT * FROM domains WHERE domain = $1",
    findAll: `
      SELECT * FROM domains
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `,
    count: "SELECT COUNT(*) as count FROM domains"
  },
  analysisRuns: {
    createQueuedRun: `
      INSERT INTO analysis_runs (domain_id, status, source)
      VALUES ($1, 'queued', $2)
      RETURNING *
    `,
    attachBullMqJob: `
      UPDATE analysis_runs
      SET bullmq_job_id = $2, updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    markProcessing: `
      UPDATE analysis_runs
      SET
        status = 'processing',
        started_at = coalesce(started_at, now()),
        updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    markFinished: `
      UPDATE analysis_runs
      SET
        status = $2,
        error_message = $3,
        completed_at = now(),
        updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    findById: `
      SELECT *
      FROM analysis_runs
      WHERE id = $1
    `,
    findPreviousSuccessfulRun: `
      SELECT *
      FROM analysis_runs
      WHERE domain_id = $1
        AND id <> $2
        AND status IN ('completed', 'partial_success')
      ORDER BY completed_at DESC NULLS LAST, id DESC
      LIMIT 1
    `
  },
  analysisDiffs: {
    insert: `
      INSERT INTO analysis_diffs (
        domain_id,
        analysis_run_id,
        previous_analysis_run_id,
        diff_type,
        provider,
        old_value,
        new_value,
        severity
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
    findByRunId: `
      SELECT *
      FROM analysis_diffs
      WHERE analysis_run_id = $1
      ORDER BY created_at DESC
    `
  },
  notifications: {
    insert: `
      INSERT INTO notifications (
        domain_id,
        analysis_diff_id,
        channel,
        payload
      )
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    findById: `
      SELECT *
      FROM notifications
      WHERE id = $1
    `,
    markSent: `
      UPDATE notifications
      SET
        status = 'sent',
        sent_at = now(),
        error_message = null
      WHERE id = $1
      RETURNING *
    `,
    markFailed: `
      UPDATE notifications
      SET
        status = 'failed',
        error_message = $2
      WHERE id = $1
      RETURNING *
    `
  },
  providerAnalysis: {
    upsert: `
      INSERT INTO provider_analysis (
        domain_id,
        llm_name,
        top_k,
        rank_position,
        mention_count,
        score,
        status,
        error_message,
        last_run
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      ON CONFLICT (domain_id, llm_name, top_k)
      DO UPDATE SET
        rank_position = EXCLUDED.rank_position,
        mention_count = EXCLUDED.mention_count,
        score = EXCLUDED.score,
        status = EXCLUDED.status,
        error_message = EXCLUDED.error_message,
        last_run = now(),
        updated_at = now()
      RETURNING id
    `,
    findStatusesForDomain: `
      SELECT
        llm_name,
        CASE
          WHEN bool_or(status = 'completed') THEN 'completed'
          ELSE 'failed'
        END AS status,
        max(error_message) FILTER (WHERE error_message IS NOT NULL) AS error_message
      FROM provider_analysis
      WHERE domain_id = $1
      GROUP BY llm_name
      ORDER BY llm_name
    `,
    findLatestScoringRowsForDomain: `
      SELECT
        llm_name,
        top_k,
        rank_position,
        mention_count,
        score,
        status
      FROM provider_analysis
      WHERE domain_id = $1
      ORDER BY llm_name ASC, top_k ASC
    `,
    findLatestScoresByDomainAndProvider: `
      SELECT
        id,
        domain_id,
        llm_name,
        top_k,
        rank_position,
        mention_count,
        score,
        status,
        error_message,
        last_run,
        updated_at
      FROM provider_analysis
      WHERE domain_id = $1
        AND llm_name = $2
      ORDER BY top_k ASC
    `,
    findLatestScoresByDomain: `
      SELECT
        id,
        domain_id,
        llm_name,
        top_k,
        rank_position,
        mention_count,
        score,
        status,
        error_message,
        last_run,
        updated_at
      FROM provider_analysis
      WHERE domain_id = $1
      ORDER BY llm_name ASC, top_k ASC
    `
  },
  providerSnapshots: {
    insert: `
      INSERT INTO provider_snapshots (
        analysis_run_id,
        domain_id,
        llm_name,
        top_k,
        rank_position,
        mention_count,
        score,
        status,
        error_message
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `,
    findByRunId: `
      SELECT *
      FROM provider_snapshots
      WHERE analysis_run_id = $1
      ORDER BY llm_name ASC, top_k ASC
    `,
    findLatestByDomain: `
      SELECT DISTINCT ON (llm_name, top_k)
        llm_name,
        top_k,
        mention_count,
        score,
        status
      FROM provider_snapshots
      WHERE domain_id = $1
      ORDER BY llm_name, top_k, created_at DESC
    `,
    findHistoryByDomainAndProvider: `
      SELECT *
      FROM provider_snapshots
      WHERE domain_id = $1
        AND llm_name = $2
      ORDER BY created_at DESC
      LIMIT $3
    `
  },
  domainSchedules: {
    findDue: `
      SELECT
        s.*,
        d.domain
      FROM domain_schedules s
      JOIN domains d ON d.id = s.domain_id
      WHERE s.enabled = true
        AND s.next_run_at <= now()
      ORDER BY s.next_run_at ASC
      LIMIT $1
    `,
    markEnqueued: `
      UPDATE domain_schedules
      SET
        last_enqueued_at = now(),
        next_run_at = $2,
        updated_at = now()
      WHERE id = $1
      RETURNING *
    `
  },
  visibilityScores: {
    findLatest: `
      SELECT *
      FROM visibility_scores
      WHERE domain_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    findHistory: `
      SELECT *
      FROM visibility_scores
      WHERE domain_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    insert: `
      INSERT INTO visibility_scores (
        analysis_run_id,
        domain_id,
        openai_score,
        gemini_score,
        claude_score,
        coverage_score,
        consistency_score,
        mention_frequency_score,
        overall_geo_score
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
    findByRunId: `
      SELECT *
      FROM visibility_scores
      WHERE analysis_run_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `
  }
} as const;
