import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const unitRoot = new URL("../tests/unit/", import.meta.url);
const files = (await readdir(unitRoot, { recursive: true }))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => `tests/unit/${name.replaceAll("\\", "/")}`);
if (files.length === 0) throw new Error("No unit test files found");

const tsxCli = fileURLToPath(
  new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)
);
const child = spawn(process.execPath, [tsxCli, "--test", ...files], {
  stdio: "inherit",
  env: process.env
});
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
