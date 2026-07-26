import { env } from "../../../common/config/env.js";
import { pool } from "../../../common/database/postgres.js";
import { RabbitMqConnection } from "../../../common/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../../common/messaging/rabbitmq.topology.js";
import { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import { ClassificationResultWorkerRuntime } from "../runtime/classification-result-worker.runtime.js";
import { ClassificationResultService } from "../services/classification-result.service.js";
import { ClassificationResultWorker } from "../workers/classification-result-worker.js";

const rabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});
let runtime: ClassificationResultWorkerRuntime | null = null;

async function main() {
  const channel = await rabbitMq.getConfirmChannel();
  runtime = new ClassificationResultWorkerRuntime(
    channel,
    new ClassificationResultWorker(new ClassificationResultService(pool)),
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
  console.error("Classification result worker failed.", error);
  process.exitCode = 1;
  await shutdown();
});
