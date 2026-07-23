import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tsxCli = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
);
const child = spawn(
  process.execPath,
  [tsxCli, "--test", "tests/migrations.test.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_MIGRATION_TESTS: "true",
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test"
    }
  }
);

child.on("error", (error) => {
  console.error("Failed to start migration tests.", error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Migration tests terminated by signal ${signal}.`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
