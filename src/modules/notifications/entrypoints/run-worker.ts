import { env } from "../../../common/config/env.js";
import { pool } from "../../../common/database/postgres.js";
import { RabbitMqConnection } from "../../../common/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../../common/messaging/rabbitmq.topology.js";
import { NotificationService } from "../services/notification.service.js";
import { NotificationWorker } from "../workers/notification-worker.js";
import { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import { NotificationWorkerRuntime } from "../runtime/notification-worker.runtime.js";

const rabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});
let runtime: NotificationWorkerRuntime | null = null;
let stopping = false;

async function main() {
  runtime = new NotificationWorkerRuntime(
    await rabbitMq.getConfirmChannel(),
    new NotificationWorker(new NotificationService(pool)),
    new FailureRecordRepository(pool),
    {
      mainExchange: env.RABBITMQ_EXCHANGE,
      prefetch: env.NOTIFICATION_WORKER_PREFETCH
    }
  );
  await runtime.start();
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  console.info(`Received ${signal}. Stopping notification worker.`);
  await runtime?.stop();
  await rabbitMq.close();
  await pool.end();
}

main().catch(async (error) => {
  console.error("Notification worker failed.", error);
  process.exitCode = 1;
  await rabbitMq.close();
  await pool.end();
});
