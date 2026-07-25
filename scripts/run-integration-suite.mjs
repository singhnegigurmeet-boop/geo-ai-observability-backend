import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import amqp from "amqplib";
import pg from "pg";

const suites = {
  phase2: ["tests/phase2.integration.test.ts", "RUN_PHASE2_INTEGRATION_TESTS"],
  phase3: ["tests/phase3.integration.test.ts", "RUN_PHASE3_INTEGRATION_TESTS"],
  phase4: ["tests/phase4.integration.test.ts", "RUN_PHASE4_INTEGRATION_TESTS"],
  phase45: ["tests/phase45.integration.test.ts", "RUN_PHASE45_INTEGRATION_TESTS"],
  phase5: ["tests/phase5.integration.test.ts", "RUN_PHASE5_INTEGRATION_TESTS"],
  phase6: ["tests/phase6.integration.test.ts", "RUN_PHASE6_INTEGRATION_TESTS"],
  phase7: ["tests/phase7.integration.test.ts", "RUN_PHASE7_INTEGRATION_TESTS"],
  phase8: ["tests/phase8.integration.test.ts", "RUN_PHASE8_INTEGRATION_TESTS"],
  phase9: ["tests/phase9.integration.test.ts", "RUN_PHASE9_INTEGRATION_TESTS"],
  phase10: ["tests/phase10.integration.test.ts", "RUN_PHASE10_INTEGRATION_TESTS"],
  phase11: ["tests/phase11.integration.test.ts", "RUN_PHASE11_INTEGRATION_TESTS"],
  phase12: ["tests/phase12.integration.test.ts", "RUN_PHASE12_INTEGRATION_TESTS"],
  e2e: ["tests/v6.e2e.test.ts", "RUN_V6_E2E_TESTS"]
};

const suiteName = process.argv[2];
const suite = suites[suiteName];
if (!suite) {
  throw new Error(
    `Unknown integration suite "${suiteName ?? ""}". Expected: ${Object.keys(suites).join(", ")}`
  );
}

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
const [testFile, enableFlag] = suite;
const child = spawn(process.execPath, [tsxCli, "--test", testFile], {
  stdio: "inherit",
  env: {
    ...process.env,
    [enableFlag]: "true",
    TEST_DATABASE_URL: databaseUrl,
    TEST_RABBITMQ_URL: rabbitMqUrl
  }
});
child.on("error", (error) => {
  console.error(`Failed to start ${suiteName} integration suite.`, error);
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
    `Test infrastructure did not become ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
