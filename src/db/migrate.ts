import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../lib/postgres.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const migrationsDir = path.join(currentDir, "migrations");
const requiredTables = [
  "domains",
  "provider_analysis",
  "provider_snapshots",
  "visibility_scores",
  "analysis_diffs",
  "analysis_runs",
  "schema_migrations"
];

async function migrate() {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const file of files) {
    const existing = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [file]);
    if (existing.rowCount) {
      console.log(`Skipping already applied migration: ${file}`);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }

  await verifyRequiredTables();

  await pool.end();
}

async function verifyRequiredTables() {
  const result = await pool.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [requiredTables]
  );

  const existingTables = new Set(result.rows.map((row) => row.table_name));
  const missingTables = requiredTables.filter((table) => !existingTables.has(table));

  if (missingTables.length > 0) {
    throw new Error(
      `Migration verification failed. Missing table(s): ${missingTables.join(", ")}. ` +
        "If schema_migrations says migrations were applied, drop schema_migrations and rerun migrations."
    );
  }

  console.log(`Migration verification passed: ${requiredTables.join(", ")}`);
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
