import { env } from "../config/env.js";
import { pool } from "../lib/postgres.js";
import { RabbitMqConnection } from "../messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../messaging/rabbitmq.topology.js";
import { MockProviderService } from "../providers/mock-provider.service.js";
import { MockProviderWorker } from "../providers/mock-provider-worker.js";
import { FailureRecordRepository } from "../reliability/failure-record.repository.js";
import { MockProviderWorkerRuntime } from "../runtime/mock-provider-worker.runtime.js";

const rabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});

let shuttingDown = false;
let runtime: MockProviderWorkerRuntime | null = null;

async function main() {
  const channel = await rabbitMq.getConfirmChannel();
  runtime = new MockProviderWorkerRuntime(
    channel,
    new MockProviderWorker(new MockProviderService(pool)),
    new FailureRecordRepository(pool),
    {
      mainExchange: env.RABBITMQ_EXCHANGE,
      prefetch: env.MOCK_PROVIDER_WORKER_PREFETCH
    }
  );
  await runtime.start();
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Stopping mock provider worker...`);
  await runtime?.stop();
  await rabbitMq.close();
  await pool.end();
}

main().catch(async (error) => {
  console.error("Mock provider worker failed.", error);
  process.exitCode = 1;
  await rabbitMq.close();
  await pool.end();
});
