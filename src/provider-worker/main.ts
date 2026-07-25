import { ClaudeProviderAdapter } from "../providers/claude.provider-adapter.js";
import { env } from "../config/env.js";
import { pool } from "../lib/postgres.js";
import { RabbitMqConnection } from "../messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../messaging/rabbitmq.topology.js";
import { FetchProviderHttpClient } from "../providers/fetch-provider-http-client.js";
import { GeminiProviderAdapter } from "../providers/gemini.provider-adapter.js";
import { OpenAiProviderAdapter } from "../providers/openai.provider-adapter.js";
import { ProviderAdapterRegistry } from "../providers/provider-adapter.registry.js";
import { ProviderExecutionService } from "../providers/provider-execution.service.js";
import { ProviderWorker } from "../providers/provider-worker.js";
import { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import { ProviderWorkerRuntime } from "../runtime/provider-worker.runtime.js";
import type { ProviderName } from "../types/database.types.js";

const provider = process.argv[2];
if (provider !== "openai" && provider !== "gemini" && provider !== "claude") {
  throw new Error("Provider worker requires openai, gemini, or claude argument");
}
const providerName: Exclude<ProviderName, "mock"> = provider;
if (!env.ENABLE_REAL_PROVIDERS) {
  throw new Error("Real provider workers require ENABLE_REAL_PROVIDERS=true");
}

const http = new FetchProviderHttpClient();
const configuration = {
  openai: {
    adapter: new OpenAiProviderAdapter(http, env.OPENAI_API_KEY),
    timeoutMs: env.OPENAI_TIMEOUT_MS
  },
  gemini: {
    adapter: new GeminiProviderAdapter(http, env.GEMINI_API_KEY),
    timeoutMs: env.GEMINI_TIMEOUT_MS
  },
  claude: {
    adapter: new ClaudeProviderAdapter(http, env.CLAUDE_API_KEY),
    timeoutMs: env.CLAUDE_TIMEOUT_MS
  }
} satisfies Record<
  Exclude<ProviderName, "mock">,
  { adapter: OpenAiProviderAdapter | GeminiProviderAdapter | ClaudeProviderAdapter; timeoutMs: number }
>;
const selected = configuration[providerName];
const rabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});
let runtime: ProviderWorkerRuntime | null = null;
let shuttingDown = false;

async function main() {
  const channel = await rabbitMq.getConfirmChannel();
  runtime = new ProviderWorkerRuntime(
    channel,
    new ProviderWorker(
      providerName,
      new ProviderExecutionService(
        pool,
        new ProviderAdapterRegistry([selected.adapter]),
        selected.timeoutMs
      )
    ),
    new FailureRecordRepository(pool),
    {
      queueName: `${providerName}_queue`,
      mainExchange: env.RABBITMQ_EXCHANGE,
      prefetch: env.REAL_PROVIDER_WORKER_PREFETCH,
      workerLabel: `${providerName} provider worker`
    }
  );
  await runtime.start();
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}. Stopping ${provider} provider worker.`);
  await runtime?.stop();
  await rabbitMq.close();
  await pool.end();
}

main().catch(async (error) => {
  console.error(`${provider} provider worker failed.`, error);
  process.exitCode = 1;
  await rabbitMq.close();
  await pool.end();
});
