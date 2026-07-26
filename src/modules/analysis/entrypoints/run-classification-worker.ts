import { env } from "../../../common/config/env.js";
import { pool } from "../../../common/database/postgres.js";
import { RabbitMqConnection } from "../../../common/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../../common/messaging/rabbitmq.topology.js";
import { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import { ClassificationWorkerRuntime } from "../runtime/classification-worker.runtime.js";
import { ClassificationPlanningService } from "../services/classification-planning.service.js";
import { ClassificationWorker } from "../workers/classification-worker.js";

const rabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});

let runtime: ClassificationWorkerRuntime | null = null;

async function main() {
  const channel = await rabbitMq.getConfirmChannel();
  runtime = new ClassificationWorkerRuntime(
    channel,
    new ClassificationWorker(
      new ClassificationPlanningService(pool, env.ENABLE_REAL_PROVIDERS)
    ),
    new FailureRecordRepository(pool),
    {
      mainExchange: env.RABBITMQ_EXCHANGE,
      prefetch: env.CLASSIFICATION_WORKER_PREFETCH
    }
  );
  await runtime.start();
}

async function shutdown() {
  await runtime?.stop();
  await rabbitMq.close();
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
main().catch(async (error) => {
  console.error("Classification worker failed.", error);
  process.exitCode = 1;
  await shutdown();
});
