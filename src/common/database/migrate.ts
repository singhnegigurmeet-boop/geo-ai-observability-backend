import { pool } from "./postgres.js";
import { getDefaultMigrationsDirectory, runMigrations } from "./migration-runner.js";

async function main() {
  const result = await runMigrations({
    pool,
    migrationsDirectory: getDefaultMigrationsDirectory()
  });

  if (result.applied.length === 0) {
    console.log(`Schema is current. Skipped ${result.skipped.length} applied migration(s).`);
    return;
  }

  for (const migration of result.applied) {
    console.log(`Applied migration ${migration.version}: ${migration.filename}`);
  }

  console.log(
    `Migration complete. Applied ${result.applied.length}; skipped ${result.skipped.length}.`
  );
}

main()
  .catch((error) => {
    console.error("Migration failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
