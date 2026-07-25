import { env } from "../../../common/config/env.js";
import { pool } from "../../../common/database/postgres.js";
import type { PromptQueueName } from "../../../common/messaging/queue-names.js";
import { RabbitMqConnection } from "../../../common/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../../common/messaging/rabbitmq.topology.js";
import { PromptExecutionService } from "../services/prompt-execution.service.js";
import { PromptWorker } from "../workers/prompt-worker.js";
import { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import { PromptWorkerRuntime } from "../runtime/prompt-worker.runtime.js";
import type { PromptType } from "../../../common/types/database.types.js";

const promptRoutes = [
  ["competitor", "competitor_prompt_queue"],
  ["ranking", "ranking_prompt_queue"],
  ["visibility", "visibility_prompt_queue"],
  ["price_range", "price_range_prompt_queue"],
  ["pros_cons", "pros_cons_prompt_queue"]
] as const satisfies readonly [PromptType, PromptQueueName][];

const rabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});

let shuttingDown = false;
const runtimes: PromptWorkerRuntime[] = [];

async function main() {
  const channel = await rabbitMq.getConfirmChannel();
  const execution = new PromptExecutionService(
    pool,
    undefined,
    env.ENABLE_REAL_PROVIDERS
  );
  const failures = new FailureRecordRepository(pool);
  for (const [promptType, queueName] of promptRoutes) {
    const runtime = new PromptWorkerRuntime(
      channel,
      new PromptWorker(promptType, execution),
      failures,
      {
        queueName,
        mainExchange: env.RABBITMQ_EXCHANGE,
        prefetch: env.PROMPT_WORKER_PREFETCH
      }
    );
    runtimes.push(runtime);
    await runtime.start();
  }
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Stopping prompt workers...`);
  await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
  await rabbitMq.close();
  await pool.end();
}

main().catch(async (error) => {
  console.error("Prompt workers failed.", error);
  process.exitCode = 1;
  await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
  await rabbitMq.close();
  await pool.end();
});
