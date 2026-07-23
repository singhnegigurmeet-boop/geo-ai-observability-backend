import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { MIGRATION_QUERIES } from "./sql-queries.js";

const MIGRATION_FILENAME_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export type MigrationFile = {
  version: number;
  filename: string;
  checksum: string;
  sql: string;
};

export type AppliedMigration = {
  version: number;
  filename: string;
  checksum: string;
  applied_at: Date;
};

export type MigrationRunResult = {
  applied: MigrationFile[];
  skipped: MigrationFile[];
};

export type MigrationRunnerOptions = {
  pool: Pick<Pool, "connect">;
  migrationsDirectory: string;
};

export function getDefaultMigrationsDirectory() {
  const currentFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(currentFile), "migrations");
}

export async function loadMigrationFiles(migrationsDirectory: string): Promise<MigrationFile[]> {
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  const seenVersions = new Set<number>();
  const migrations: MigrationFile[] = [];

  for (const filename of filenames) {
    const match = MIGRATION_FILENAME_PATTERN.exec(filename);
    if (!match) {
      throw new Error(
        `Invalid migration filename "${filename}". Expected NNN_lowercase_name.sql.`
      );
    }

    const version = Number(match[1]);
    if (seenVersions.has(version)) {
      throw new Error(`Duplicate migration version: ${version}`);
    }
    seenVersions.add(version);

    const sql = await readFile(path.join(migrationsDirectory, filename), "utf8");
    migrations.push({
      version,
      filename,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex")
    });
  }

  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (previous && current && current.version <= previous.version) {
      throw new Error("Migration files are not in strictly increasing version order");
    }
  }

  return migrations;
}

export async function runMigrations(options: MigrationRunnerOptions): Promise<MigrationRunResult> {
  const migrations = await loadMigrationFiles(options.migrationsDirectory);
  const client = await options.pool.connect();
  let transactionOpen = false;

  try {
    await client.query(MIGRATION_QUERIES.acquireAdvisoryLock);
    await bootstrapMigrationLedger(client);

    const appliedRows = await loadAppliedMigrations(client);
    await assertMigrationHistoryIsValid(migrations, appliedRows);
    await assertFreshPublicSchema(client, appliedRows);

    const appliedVersions = new Set(appliedRows.map((migration) => migration.version));
    const result: MigrationRunResult = {
      applied: [],
      skipped: []
    };

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        result.skipped.push(migration);
        continue;
      }

      await client.query("BEGIN");
      transactionOpen = true;

      const startedAt = process.hrtime.bigint();
      await client.query(migration.sql);
      const executionMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      await client.query(MIGRATION_QUERIES.insertAppliedMigration, [
        migration.version,
        migration.filename,
        migration.checksum,
        Math.round(executionMilliseconds)
      ]);

      await client.query("COMMIT");
      transactionOpen = false;
      result.applied.push(migration);
    }

    return result;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    try {
      await client.query(MIGRATION_QUERIES.releaseAdvisoryLock);
    } finally {
      client.release();
    }
  }
}

async function bootstrapMigrationLedger(client: PoolClient) {
  await client.query("BEGIN");
  try {
    await client.query(MIGRATION_QUERIES.createMetadataSchema);
    await client.query(MIGRATION_QUERIES.createMigrationLedger);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function loadAppliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(MIGRATION_QUERIES.listAppliedMigrations);
  return result.rows;
}

async function assertMigrationHistoryIsValid(
  files: MigrationFile[],
  appliedRows: AppliedMigration[]
) {
  const filesByVersion = new Map(files.map((file) => [file.version, file]));

  for (const [index, applied] of appliedRows.entries()) {
    const file = filesByVersion.get(applied.version);
    if (!file) {
      throw new Error(
        `Applied migration ${applied.version} (${applied.filename}) is missing from the repository`
      );
    }
    if (file.filename !== applied.filename) {
      throw new Error(
        `Applied migration ${applied.version} filename changed from ${applied.filename} to ${file.filename}`
      );
    }
    if (file.checksum !== applied.checksum) {
      throw new Error(
        `Applied migration ${applied.version} (${applied.filename}) checksum does not match`
      );
    }

    const expectedFile = files[index];
    if (expectedFile?.version !== applied.version) {
      throw new Error(
        `Applied migrations are not a contiguous prefix of the repository history at version ${applied.version}`
      );
    }
  }
}

async function assertFreshPublicSchema(
  client: PoolClient,
  appliedRows: AppliedMigration[]
) {
  if (appliedRows.length > 0) {
    return;
  }

  const result = await client.query<{ table_name: string }>(
    MIGRATION_QUERIES.listPublicTables
  );
  if (result.rows.length > 0) {
    const names = result.rows.map((row) => row.table_name).join(", ");
    throw new Error(
      `Fresh GEO V6 database required. Refusing to migrate non-empty public schema containing: ${names}`
    );
  }
}
