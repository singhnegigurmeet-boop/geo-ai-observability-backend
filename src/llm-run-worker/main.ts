import { env } from "../config/env.js";
import { pool } from "../lib/postgres.js";
import { LlmRunWorker } from "../llm/llm-run-worker.js";
import { RabbitMqConnection } from "../messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../messaging/rabbitmq.topology.js";
import { PromptPlanningService } from "../prompts/prompt-planning.service.js";
import { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import { LlmRunWorkerRuntime } from "../runtime/llm-run-worker.runtime.js";

const rabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});

let shuttingDown = false;
let runtime: LlmRunWorkerRuntime | null = null;

async function main() {
  const channel = await rabbitMq.getConfirmChannel();
  runtime = new LlmRunWorkerRuntime(
    channel,
    new LlmRunWorker(new PromptPlanningService(pool)),
    new FailureRecordRepository(pool),
    {
      mainExchange: env.RABBITMQ_EXCHANGE,
      prefetch: env.LLM_RUN_WORKER_PREFETCH
    }
  );
  await runtime.start();
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Stopping LLM run worker...`);
  await runtime?.stop();
  await rabbitMq.close();
  await pool.end();
}

main().catch(async (error) => {
  console.error("LLM run worker failed.", error);
  process.exitCode = 1;
  await rabbitMq.close();
  await pool.end();
});
