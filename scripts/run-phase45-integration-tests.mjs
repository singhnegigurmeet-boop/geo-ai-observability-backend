import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test";

await waitForPostgres(databaseUrl);

const tsxCli = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
);
const child = spawn(
  process.execPath,
  [tsxCli, "--test", "tests/phase45.integration.test.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_PHASE45_INTEGRATION_TESTS: "true",
      TEST_DATABASE_URL: databaseUrl
    }
  }
);

child.on("error", (error) => {
  console.error("Failed to start Phase 4.5 integration tests.", error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(
      `Phase 4.5 integration tests terminated by signal ${signal}.`
    );
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

async function waitForPostgres(connectionString) {
  const deadline = Date.now() + 30_000;
  let lastError;

  while (Date.now() < deadline) {
    const client = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 1_000
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(
    `PostgreSQL did not become ready within 30 seconds: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
