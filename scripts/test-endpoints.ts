// scripts/test-endpoints.ts
import { spawn, ChildProcess } from "node:child_process";
import dotenv from "dotenv";
import { Redis } from "ioredis";
import pg from "pg";

dotenv.config();
process.env.DATABASE_URL ??= "postgres://geo_user:geo_pass_123@localhost:5432/geo_observability";
process.env.REDIS_URL ??= "redis://localhost:6379/15";
process.env.ELASTICSEARCH_NODE ??= "http://localhost:9200";

const BASE_URL = process.env.API_BASE_URL ?? "http://127.0.0.1:4000";
const PROVIDER = process.env.TEST_PROVIDER ?? "openai";
const POLL_TIMEOUT_SECONDS = Number(process.env.TEST_POLL_TIMEOUT_SECONDS ?? 90);
const POLL_INTERVAL_SECONDS = Number(process.env.TEST_POLL_INTERVAL_SECONDS ?? 2);
const SHOW_RESPONSES = process.env.SHOW_RESPONSES ?? "true";
const MAX_RESPONSE_CHARS = Number(process.env.MAX_RESPONSE_CHARS ?? 4000);
const USE_EXISTING_SERVER = process.env.USE_EXISTING_SERVER === "true";
const TEST_DOMAINS = [
  "nike.com",
  "adidas.com",
  "puma.com",
  "apple.com",
  "samsung.com",
  "sony.com",
  "figma.com",
  "notion.so",
  "slack.com",
  "hubspot.com",
  "salesforce.com",
  "shopify.com",
  "stripe.com",
  "airbnb.com",
  "booking.com"
] as const;

let serverProcess: ChildProcess | null = null;

type Json = Record<string, any>;

function getTestDomains() {
  return process.env.TEST_DOMAIN ? [process.env.TEST_DOMAIN] : [...TEST_DOMAINS];
}

function getClientIp(index: number) {
  return process.env.TEST_CLIENT_IP ?? `127.0.1.${(index % 200) + 20}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDocsEndpoint(path: string) {
  return path === "/docs" || path === "/openapi.json";
}

function printResponse(label: string, body: string, path: string) {
  if (SHOW_RESPONSES !== "true") return;

  // Do not print Swagger/OpenAPI logs
  if (isDocsEndpoint(path)) return;

  console.error(`----- response: ${label} -----`);

  if (!body) {
    console.error("<empty>");
    console.error("----- end response -----");
    return;
  }

  let text = body;

  try {
    text = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    text = body.replace(/\s+/g, " ").trim();
  }

  if (text.length > MAX_RESPONSE_CHARS) {
    console.error(
      `${text.slice(0, MAX_RESPONSE_CHARS)}\n... <truncated ${
        text.length - MAX_RESPONSE_CHARS
      } chars>`
    );
  } else {
    console.error(text);
  }

  console.error("----- end response -----");
}

async function request(
  method: string,
  path: string,
  expected: number[],
  body?: Json,
  clientIp = getClientIp(0)
): Promise<Json> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "X-Forwarded-For": clientIp,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();

  if (!expected.includes(response.status)) {
    console.error(`FAIL ${method} ${path} -> ${response.status}`);
    console.error("Response:");
    console.error(text);
    process.exit(1);
  }

  console.error(`OK   ${method} ${path} -> ${response.status}`);
  printResponse(`${method} ${path}`, text, path);

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function assertJson(label: string, condition: boolean, data: unknown) {
  if (!condition) {
    console.error(`FAIL ${label}`);
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
}

function assertCurrentAnalysisContract(response: Json) {
  assertJson(
    "analysis response uses analysis_run_id, not legacy job_id. Stop the old API process on port 4000 and restart from the current build.",
    typeof response.analysis_run_id === "number" && response.job_id === undefined,
    response
  );

  assertJson(
    "analysis response has timestamped bullmq_job_id",
    typeof response.bullmq_job_id === "string" &&
      /^analysis-run-\d+-\d+$/.test(response.bullmq_job_id),
    response
  );
}

function assertCurrentStatusContract(response: Json, analysisRunId: number) {
  assertJson(
    "status response uses analysis_run_id, not legacy job_id. Stop the old API process on port 4000 and restart from the current build.",
    response.analysis_run_id === analysisRunId && response.job_id === undefined,
    response
  );
}

async function waitForHealth() {
  console.log(`Waiting for API health at ${BASE_URL}/health`);

  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        console.log("API is healthy");
        return;
      }
    } catch {
      // ignore
    }

    await sleep(1000);
  }

  console.error("API did not become healthy.");
  process.exit(1);
}

async function isServerRunning() {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed`));
    });
  });
}

async function resetRedisState() {
  if ((process.env.RESET_REDIS ?? "true") !== "true") {
    return;
  }

  console.log(`Resetting Redis state for ${process.env.REDIS_URL}`);
  const redis = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null
  });

  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}

async function prepareDomainForAnalysis(domain: string) {
  console.log(`Preparing ${domain} for a fresh analysis run`);

  const redis = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null
  });
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await redis.del(`analysis:${domain}`);
    await pool.query(
      `
        UPDATE visibility_scores
        SET created_at = now() - interval '48 hours'
        WHERE domain_id = (
          SELECT id
          FROM domains
          WHERE domain = $1
        )
      `,
      [domain]
    );
  } finally {
    await redis.quit();
    await pool.end();
  }
}

async function startServer() {
  if (await isServerRunning()) {
    if (USE_EXISTING_SERVER) {
      console.log(`API is already running at ${BASE_URL}; using existing server because USE_EXISTING_SERVER=true`);
      return;
    }

    console.error(`API is already running at ${BASE_URL}.`);
    console.error("Stop the existing server first, or rerun with USE_EXISTING_SERVER=true if you intentionally want to test it.");
    process.exit(1);
  }

  console.log("Building project");
  await runCommand("npm", ["run", "build"]);

  if ((process.env.RUN_MIGRATIONS ?? "true") === "true") {
    console.log("Running migrations");
    await runCommand("npm", ["run", "migrate"]);
  }

  await resetRedisState();

  console.log("Starting API server from current build");

  serverProcess = spawn(process.execPath, ["dist/main.js"], {
    env: process.env,
    stdio: "ignore",
    shell: process.platform === "win32",
  });

  await waitForHealth();
}

async function waitForRun(analysisRunId: number, clientIp: string): Promise<Json> {
  let elapsed = 0;

  console.error(`Polling analysis run ${analysisRunId}`);

  while (elapsed <= POLL_TIMEOUT_SECONDS) {
    const response = await request("GET", `/v1/analysis/runs/${analysisRunId}`, [200, 202], undefined, clientIp);

    const status = response.status;

    if (status === "completed" || status === "partial_success") {
      assertCurrentStatusContract(response, analysisRunId);

      assertJson(
        `analysis run ${analysisRunId} completed response has run-linked visibility score`,
        response.data?.analysis_run_id === response.analysis_run_id,
        response
      );

      console.error(`Analysis run ${analysisRunId} finished with status ${status}`);
      return response;
    }

    if (status === "failed") {
      console.error(`Analysis run ${analysisRunId} failed`);
      console.error(JSON.stringify(response, null, 2));
      process.exit(1);
    }

    await sleep(POLL_INTERVAL_SECONDS * 1000);
    elapsed += POLL_INTERVAL_SECONDS;
  }

  console.error(`Timed out waiting for analysis run ${analysisRunId}`);
  process.exit(1);
}

function cleanup() {
  if (serverProcess?.pid) {
    console.log(`Stopping API server (${serverProcess.pid})`);
    serverProcess.kill();
    serverProcess = null;
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

async function runDomainSmoke(domain: string, index: number) {
  const clientIp = getClientIp(index);

  await prepareDomainForAnalysis(domain);

  console.log(`\nSubmitting analysis for ${domain}`);

  const analysisResponse = await request("POST", "/v1/analysis", [200, 202], {
    domain
  }, clientIp);

  assertJson(
    "analysis response has status",
    typeof analysisResponse.status === "string",
    analysisResponse
  );

  assertCurrentAnalysisContract(analysisResponse);

  const analysisRunId = analysisResponse.analysis_run_id;
  let domainId =
    analysisResponse.domain_id ?? analysisResponse.data?.domain_id;

  if (analysisRunId) {
    const runResponse = await waitForRun(analysisRunId, clientIp);
    domainId =
      domainId ?? runResponse.domain_id ?? runResponse.data?.domain_id;
  }

  if (!domainId) {
    console.error("Could not determine domain_id from analysis response");
    process.exit(1);
  }

  console.log(`\nChecking read endpoints for domain_id=${domainId}, provider=${PROVIDER}`);

  await request("GET", `/v1/analysis/runs/${analysisRunId ?? 1}`, [200, 202, 404], undefined, clientIp);

  if (analysisRunId) {
    const diffsResponse = await request(
      "GET",
      `/v1/analysis/runs/${analysisRunId}/diffs`,
      [200],
      undefined,
      clientIp
    );

    assertJson(
      "diff response has expected shape",
      diffsResponse.status === "found" &&
        diffsResponse.source === "analysis_diffs" &&
        diffsResponse.analysis_run_id === analysisRunId &&
        Array.isArray(diffsResponse.diffs),
      diffsResponse
    );
  } else {
    await request("GET", "/v1/analysis/runs/1/diffs", [200, 404], undefined, clientIp);
  }

  await request("GET", `/v1/domains/${domainId}/providers/${PROVIDER}/scores`, [200], undefined, clientIp);
  await request("GET", `/v1/domains/${domainId}/providers/${PROVIDER}/history`, [200], undefined, clientIp);
  await request("GET", `/v1/domains/${domainId}/provider-scores`, [200], undefined, clientIp);
  await request("GET", `/v1/domains/${domainId}/visibility-score`, [200], undefined, clientIp);
  await request("GET", `/v1/domains/${domainId}/visibility-score/history`, [200], undefined, clientIp);
  await request("GET", `/v1/domains/${domainId}/visibility-score/trend`, [200], undefined, clientIp);

  const scheduleResponse = await request("POST", "/v1/schedules", [200], {
    domain,
    cadence: "weekly",
    enabled: true
  }, clientIp);
  const scheduleId = scheduleResponse.schedule?.id;

  assertJson("schedule response has schedule id", typeof scheduleId === "number", scheduleResponse);

  await request("GET", "/v1/schedules", [200], undefined, clientIp);
  await request("PATCH", `/v1/schedules/${scheduleId}`, [200], { enabled: false }, clientIp);
  await request("PATCH", `/v1/schedules/${scheduleId}`, [200], { enabled: true }, clientIp);
}

async function main() {
  await startServer();

  console.log("\nChecking documentation endpoints");
  await request("GET", "/health", [200]);
  await request("GET", "/openapi.json", [200]);
  await request("GET", "/docs", [200]);

  const domains = getTestDomains();
  console.log(`\nRunning endpoint checks for ${domains.length} domain(s)`);

  for (const [index, domain] of domains.entries()) {
    await runDomainSmoke(domain, index);
  }

  console.log("\nAll endpoint checks passed.");
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    cleanup();
    process.exit(1);
  });
