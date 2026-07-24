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
  waitForPostgres(databaseUrl),
  waitForRabbitMq(rabbitMqUrl)
]);

const tsxCli = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
);
const child = spawn(
  process.execPath,
  [tsxCli, "--test", "tests/phase2.integration.test.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_PHASE2_INTEGRATION_TESTS: "true",
      TEST_DATABASE_URL: databaseUrl,
      TEST_RABBITMQ_URL: rabbitMqUrl
    }
  }
);

child.on("error", (error) => {
  console.error("Failed to start Phase 2 integration tests.", error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Phase 2 integration tests terminated by signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

async function waitForPostgres(connectionString) {
  await retryForThirtySeconds(async () => {
    const client = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 1_000
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } finally {
      await client.end().catch(() => undefined);
    }
  });
}

async function waitForRabbitMq(url) {
  await retryForThirtySeconds(async () => {
    const connection = await amqp.connect(url, { timeout: 1_000 });
    await connection.close();
  });
}

async function retryForThirtySeconds(operation) {
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
    `Infrastructure did not become ready within 30 seconds: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
