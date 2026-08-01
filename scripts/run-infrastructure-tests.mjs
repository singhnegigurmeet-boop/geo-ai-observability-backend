import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import amqp from "amqplib";
import pg from "pg";

const suites = {
  schema: ["tests/integration/common/schema.integration.test.ts", ["RUN_SCHEMA_TESTS"]],
  outbox: [
    "tests/integration/messaging/outbox-rabbitmq.integration.test.ts",
    ["RUN_OUTBOX_RABBITMQ_INTEGRATION_TESTS"]
  ],
  identity: [
    "tests/integration/identity/identity-workspace.integration.test.ts",
    ["RUN_IDENTITY_WORKSPACE_INTEGRATION_TESTS"]
  ],
  analysis: [
    "tests/integration/analysis/analysis-api.integration.test.ts",
    ["RUN_ANALYSIS_API_INTEGRATION_TESTS"]
  ],
  hierarchy: [
    "tests/integration/hierarchy/hierarchy.integration.test.ts",
    ["RUN_HIERARCHY_INTEGRATION_TESTS"]
  ],
  expansion: [
    "tests/integration/analysis/expansion-reliability.integration.test.ts",
    ["RUN_EXPANSION_RELIABILITY_INTEGRATION_TESTS"]
  ],
  discovery: [
    "tests/integration/analysis/hierarchy-discovery.integration.test.ts",
    ["RUN_HIERARCHY_DISCOVERY_INTEGRATION_TESTS"]
  ],
  llm: ["tests/integration/llm/llm-run.integration.test.ts", ["RUN_LLM_RUN_INTEGRATION_TESTS"]],
  prompts: [
    "tests/integration/prompts/prompt-planning.integration.test.ts",
    ["RUN_PROMPT_PLANNING_INTEGRATION_TESTS"]
  ],
  providers: [
    "tests/integration/prompts/prompt-provider.integration.test.ts",
    ["RUN_PROMPT_PROVIDER_INTEGRATION_TESTS"]
  ],
  reporting: [
    "tests/integration/reports/scoring-reporting.integration.test.ts",
    ["RUN_SCORING_REPORTING_INTEGRATION_TESTS"]
  ],
  budgets: [
    "tests/integration/budgets/budget-concurrency.integration.test.ts",
    ["RUN_BUDGET_CONCURRENCY_INTEGRATION_TESTS"]
  ],
  realProviders: [
    "tests/integration/providers/provider-execution.integration.test.ts",
    ["RUN_PROVIDER_EXECUTION_INTEGRATION_TESTS"]
  ],
  operations: [
    "tests/integration/observability/scheduler-notification-readiness.integration.test.ts",
    ["RUN_SCHEDULER_NOTIFICATION_INTEGRATION_TESTS"]
  ],
  e2e: ["tests/e2e/common/v6.e2e.test.ts", ["RUN_V6_E2E_TESTS"]],
  full: [
    "tests/e2e/common/v6.e2e.test.ts",
    ["RUN_V6_E2E_TESTS", "RUN_V6_FULL_E2E_TESTS"]
  ]
};

const requestedSuites = process.argv.slice(2);
if (requestedSuites.length === 0) {
  throw new Error(`Expected at least one suite: ${Object.keys(suites).join(", ")}`);
}
for (const suiteName of requestedSuites) {
  if (!suites[suiteName]) {
    throw new Error(
      `Unknown infrastructure suite "${suiteName}". Expected: ${Object.keys(suites).join(", ")}`
    );
  }
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
for (const suiteName of requestedSuites) {
  const [testFile, enableFlags] = suites[suiteName];
  const environment = {
    ...process.env,
    TEST_DATABASE_URL: databaseUrl,
    TEST_RABBITMQ_URL: rabbitMqUrl
  };
  for (const flag of enableFlags) environment[flag] = "true";
  await run(
    process.execPath,
    [tsxCli, "--test", "--test-force-exit", testFile],
    environment
  );
}

function run(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: environment });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal || code !== 0) {
        reject(new Error(`Test process failed (${signal ?? code})`));
      } else {
        resolve();
      }
    });
  });
}

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
