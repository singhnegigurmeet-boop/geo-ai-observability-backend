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
      DO UPDATE SET updated_on = now(), is_active = true
      RETURNING *
    `,
    findById: "SELECT * FROM domains WHERE domain_id = $1",
    findByName: "SELECT * FROM domains WHERE domain = $1",
    findActiveByName: "SELECT * FROM domains WHERE domain = $1 AND is_active = true",
    findAll: `
      SELECT * FROM domains
      ORDER BY created_on DESC
      LIMIT $1 OFFSET $2
    `,
    count: "SELECT COUNT(*) as count FROM domains"
  },
  coreEntities: {
    getActiveCategoryById: "SELECT * FROM categories WHERE category_id = $1 AND is_active = true",
    getActiveBrandById: "SELECT * FROM brands WHERE brand_id = $1 AND is_active = true",
    getActiveProductById: "SELECT * FROM products WHERE product_id = $1 AND is_active = true",
    getActiveUseContextById: "SELECT * FROM use_contexts WHERE context_id = $1 AND is_active = true"
  },
  entityPaths: {
    getTopCategoryPathsForDomain: `
      SELECT *
      FROM entity_paths
      WHERE domain_id = $1
        AND path_type = 'category'
        AND is_active = true
      ORDER BY created_on ASC, path_id ASC
      LIMIT $2
    `,
    validateCategoryPath: `
      SELECT *
      FROM entity_paths
      WHERE domain_id = $1
        AND category_id = $2
        AND path_type = 'category'
        AND is_active = true
      LIMIT 1
    `,
    validateBrandPath: `
      SELECT *
      FROM entity_paths
      WHERE domain_id = $1
        AND category_id = $2
        AND brand_id = $3
        AND path_type = 'brand'
        AND is_active = true
      LIMIT 1
    `,
    validateProductContextPath: `
      SELECT *
      FROM entity_paths
      WHERE domain_id = $1
        AND category_id = $2
        AND brand_id = $3
        AND product_id = $4
        AND context_id = $5
        AND path_type = 'product_context'
        AND is_active = true
      LIMIT 1
    `,
    getUseContextsForProductPath: `
      SELECT ep.*, uc.context
      FROM entity_paths ep
      JOIN use_contexts uc ON uc.context_id = ep.context_id
      WHERE ep.domain_id = $1
        AND ep.category_id = $2
        AND ep.brand_id = $3
        AND ep.product_id = $4
        AND ep.path_type = 'product_context'
        AND ep.is_active = true
        AND uc.is_active = true
      ORDER BY ep.created_on ASC, ep.path_id ASC
    `,
    createEntityPath: `
      INSERT INTO entity_paths (
        domain_id,
        category_id,
        brand_id,
        product_id,
        context_id,
        path_type
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    listActivePathsForDomain: `
      SELECT *
      FROM entity_paths
      WHERE domain_id = $1
        AND is_active = true
      ORDER BY category_id ASC, brand_id ASC NULLS FIRST, product_id ASC NULLS FIRST, context_id ASC NULLS FIRST
    `
  },
  discoveryRequests: {
    insert: `
      INSERT INTO discovery_requests (
        kind,
        requested_value,
        context_domain,
        context_category_id,
        context_brand_id,
        notes
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    listPending: `
      SELECT *
      FROM discovery_requests
      WHERE status = 'pending'
        AND is_active = true
        AND ($1::text IS NULL OR kind = $1)
        AND ($2::integer IS NULL OR context_category_id = $2)
      ORDER BY created_on ASC, request_id ASC
      LIMIT $3 OFFSET $4
    `,
    updateStatus: `
      UPDATE discovery_requests
      SET status = $2,
          updated_on = now()
      WHERE request_id = $1
        AND is_active = true
        AND $2 IN ('pending', 'rejected', 'resolved')
      RETURNING *
    `
  },
  analysisRuns: {
    createAnalysisRun: `
      INSERT INTO analysis_runs (domain_id, request_payload, status)
      VALUES ($1, $2::jsonb, coalesce($3::text, 'queued'))
      RETURNING *
    `,
    updateStatus: `
      UPDATE analysis_runs
      SET status = $2,
          updated_on = now()
      WHERE analysis_run_id = $1
        AND is_active = true
      RETURNING *
    `,
    findById: `
      SELECT ar.*
      FROM analysis_runs ar
      WHERE ar.analysis_run_id = $1
        AND ar.is_active = true
    `,
    findByIdWithDomain: `
      SELECT
        ar.*,
        d.domain
      FROM analysis_runs ar
      JOIN domains d ON d.domain_id = ar.domain_id
      WHERE ar.analysis_run_id = $1
        AND ar.is_active = true
        AND d.is_active = true
    `,
    list: `
      SELECT *
      FROM analysis_runs
      WHERE is_active = true
        AND ($1::integer IS NULL OR domain_id = $1)
        AND ($2::text IS NULL OR status = $2)
      ORDER BY created_on DESC, analysis_run_id DESC
      LIMIT $3 OFFSET $4
    `,
    findPreviousSuccessfulRun: `
      SELECT *
      FROM analysis_runs
      WHERE domain_id = $1
        AND analysis_run_id <> $2
        AND status IN ('completed', 'partial_success')
        AND is_active = true
      ORDER BY updated_on DESC, analysis_run_id DESC
      LIMIT 1
    `
  },
  analysisRunItems: {
    createMany: `
      INSERT INTO analysis_run_items (analysis_run_id, path_id)
      SELECT $1, unnest($2::integer[])
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
    listByRunId: `
      SELECT *
      FROM analysis_run_items
      WHERE analysis_run_id = $1
        AND is_active = true
      ORDER BY run_item_id ASC
    `,
    updateStatus: `
      UPDATE analysis_run_items
      SET status = $2,
          updated_on = now()
      WHERE run_item_id = $1
        AND is_active = true
      RETURNING *
    `,
    getWithPaths: `
      SELECT
        ari.run_item_id,
        ari.analysis_run_id,
        ari.path_id,
        ari.status AS run_item_status,
        ari.created_on AS run_item_created_on,
        ari.updated_on AS run_item_updated_on,
        ari.is_active AS run_item_is_active,
        ep.domain_id,
        ep.category_id,
        ep.brand_id,
        ep.product_id,
        ep.context_id,
        ep.path_type,
        ep.created_on AS path_created_on,
        ep.updated_on AS path_updated_on,
        ep.is_active AS path_is_active,
        d.domain,
        c.category,
        b.brand_name,
        p.product_name,
        uc.context
      FROM analysis_run_items ari
      JOIN entity_paths ep ON ep.path_id = ari.path_id
      JOIN domains d ON d.domain_id = ep.domain_id
      JOIN categories c ON c.category_id = ep.category_id
      LEFT JOIN brands b ON b.brand_id = ep.brand_id
      LEFT JOIN products p ON p.product_id = ep.product_id
      LEFT JOIN use_contexts uc ON uc.context_id = ep.context_id
      WHERE ari.analysis_run_id = $1
        AND ari.is_active = true
        AND ep.is_active = true
      ORDER BY ari.run_item_id ASC
    `,
    getByRunItemIdWithPath: `
      SELECT
        ari.run_item_id,
        ari.analysis_run_id,
        ari.path_id,
        ari.status AS run_item_status,
        ari.created_on AS run_item_created_on,
        ari.updated_on AS run_item_updated_on,
        ari.is_active AS run_item_is_active,
        ep.domain_id,
        ep.category_id,
        ep.brand_id,
        ep.product_id,
        ep.context_id,
        ep.path_type,
        ep.created_on AS path_created_on,
        ep.updated_on AS path_updated_on,
        ep.is_active AS path_is_active,
        d.domain,
        c.category,
        b.brand_name,
        p.product_name,
        uc.context
      FROM analysis_run_items ari
      JOIN entity_paths ep ON ep.path_id = ari.path_id
      JOIN domains d ON d.domain_id = ep.domain_id
      JOIN categories c ON c.category_id = ep.category_id
      LEFT JOIN brands b ON b.brand_id = ep.brand_id
      LEFT JOIN products p ON p.product_id = ep.product_id
      LEFT JOIN use_contexts uc ON uc.context_id = ep.context_id
      WHERE ari.run_item_id = $1
        AND ari.is_active = true
        AND ep.is_active = true
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
    upsert: `
      INSERT INTO domain_schedules (
        domain_id,
        cadence,
        enabled,
        next_run_at
      )
      VALUES ($1, $2, $3, coalesce($4::timestamptz, now()))
      ON CONFLICT (domain_id)
      DO UPDATE SET
        cadence = EXCLUDED.cadence,
        enabled = EXCLUDED.enabled,
        next_run_at = EXCLUDED.next_run_at,
        updated_at = now()
      RETURNING *
    `,
    findAll: `
      SELECT
        s.*,
        d.domain
      FROM domain_schedules s
      JOIN domains d ON d.domain_id = s.domain_id
      ORDER BY s.enabled DESC, s.next_run_at ASC, s.id ASC
      LIMIT $1 OFFSET $2
    `,
    setEnabled: `
      UPDATE domain_schedules
      SET
        enabled = $2,
        updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    findDue: `
      SELECT
        s.*,
        d.domain
      FROM domain_schedules s
      JOIN domains d ON d.domain_id = s.domain_id
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
