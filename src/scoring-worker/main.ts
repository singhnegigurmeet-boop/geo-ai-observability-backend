import { env } from "../config/env.js";
import { pool } from "../lib/postgres.js";
import { RabbitMqConnection } from "../messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../messaging/rabbitmq.topology.js";
import { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import { ProviderScoreWorkerRuntime } from "../runtime/provider-score-worker.runtime.js";
import { ProviderScoreService } from "../scoring/provider-score.service.js";
import { ProviderScoreWorker } from "../scoring/provider-score-worker.js";

const rabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});

let shuttingDown = false;
let runtime: ProviderScoreWorkerRuntime | null = null;

async function main() {
  const channel = await rabbitMq.getConfirmChannel();
  runtime = new ProviderScoreWorkerRuntime(
    channel,
    new ProviderScoreWorker(new ProviderScoreService(pool)),
    new FailureRecordRepository(pool),
    {
      mainExchange: env.RABBITMQ_EXCHANGE,
      prefetch: env.SCORING_WORKER_PREFETCH
    }
  );
  await runtime.start();
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Stopping provider score worker...`);
  await runtime?.stop();
  await rabbitMq.close();
  await pool.end();
}

main().catch(async (error) => {
  console.error("Provider score worker failed.", error);
  process.exitCode = 1;
  await rabbitMq.close();
  await pool.end();
});
