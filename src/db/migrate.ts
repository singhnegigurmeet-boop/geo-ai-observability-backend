import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../lib/postgres.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const migrationsDir = path.join(currentDir, "migrations");

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

  await pool.end();
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
