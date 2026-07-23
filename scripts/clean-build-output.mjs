import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDirectory, "..");
const buildOutput = path.resolve(workspaceRoot, "dist");
const expectedBuildOutput = path.join(workspaceRoot, "dist");

if (buildOutput !== expectedBuildOutput || path.dirname(buildOutput) !== workspaceRoot) {
  throw new Error(`Refusing to clean unexpected build output path: ${buildOutput}`);
}

await rm(buildOutput, { recursive: true, force: true });
