import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../lib/postgres.js";
import { SQL_QUERIES } from "./sql-queries.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const migrationsDir = path.join(currentDir, "migrations");
const resetTables = [
  "notifications",
  "domain_schedules",
  "analysis_diffs",
  "visibility_scores",
  "provider_snapshots",
  "provider_analysis",
  "analysis_run_items",
  "analysis_runs",
  "discovery_requests",
  "entity_paths",
  "use_contexts",
  "products",
  "brands",
  "categories",
  "domains",
  "schema_migrations"
];
const requiredTables = [
  "domains",
  "categories",
  "brands",
  "products",
  "use_contexts",
  "entity_paths",
  "discovery_requests",
  "analysis_runs",
  "analysis_run_items",
  "provider_analysis",
  "provider_snapshots",
  "visibility_scores",
  "analysis_diffs",
  "domain_schedules",
  "notifications",
  "schema_migrations"
];

async function migrate() {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  await resetSchema();

  await pool.query(SQL_QUERIES.migrations.createSchemaMigrationsTable);

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query(SQL_QUERIES.migrations.insertSchemaMigration, [file]);
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

async function resetSchema() {
  await pool.query("BEGIN");
  try {
    await pool.query(`DROP TABLE IF EXISTS ${resetTables.join(", ")} CASCADE`);
    await pool.query("COMMIT");
    console.log(`Reset development schema: ${resetTables.join(", ")}`);
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function verifyRequiredTables() {
  const result = await pool.query<{ table_name: string }>(
    SQL_QUERIES.migrations.verifyRequiredTables,
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
