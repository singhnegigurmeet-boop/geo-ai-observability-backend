import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import amqp from "amqplib";
import pg from "pg";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test";
const rabbitMqUrl =
  process.env.TEST_RABBITMQ_URL ??
  "amqp://guest:guest@127.0.0.1:5673?heartbeat=10";

await Promise.all([
  waitFor(async () => {
    const client = new pg.Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } finally {
      await client.end().catch(() => undefined);
    }
  }),
  waitFor(async () => {
    const connection = await amqp.connect(rabbitMqUrl, { timeout: 1_000 });
    await connection.close();
  })
]);

const tsxCli = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
);
const child = spawn(
  process.execPath,
  [tsxCli, "--test", "tests/phase7.integration.test.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_PHASE7_INTEGRATION_TESTS: "true",
      TEST_DATABASE_URL: databaseUrl,
      TEST_RABBITMQ_URL: rabbitMqUrl
    }
  }
);
child.on("error", (error) => {
  console.error("Failed to start Phase 7 integration tests.", error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});

async function waitFor(operation) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `Infrastructure did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
