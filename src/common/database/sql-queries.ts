export const MIGRATION_QUERIES = {
  acquireAdvisoryLock: `
    SELECT pg_advisory_lock(hashtext('geo_v6_schema_migrations'))
  `,
  releaseAdvisoryLock: `
    SELECT pg_advisory_unlock(hashtext('geo_v6_schema_migrations'))
  `,
  setMigrationSearchPath: `
    SET LOCAL search_path TO public, pg_catalog
  `,
  createMetadataSchema: `
    CREATE SCHEMA IF NOT EXISTS geo_meta
  `,
  createMigrationLedger: `
    CREATE TABLE IF NOT EXISTS geo_meta.schema_migrations (
      version integer PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum char(64) NOT NULL,
      execution_ms integer NOT NULL CHECK (execution_ms >= 0),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `,
  listAppliedMigrations: `
    SELECT version, filename, checksum, applied_at
    FROM geo_meta.schema_migrations
    ORDER BY version ASC
  `,
  insertAppliedMigration: `
    INSERT INTO geo_meta.schema_migrations (
      version,
      filename,
      checksum,
      execution_ms
    )
    VALUES ($1, $2, $3, $4)
  `,
  listPublicTables: `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name ASC
  `
} as const;
