import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { pool } from "../lib/postgres.js";
import { RabbitMqConnection } from "../messaging/rabbitmq.connection.js";
import { RabbitMqPublisher } from "../messaging/rabbitmq.publisher.js";
import { declareRabbitMqTopology } from "../messaging/rabbitmq.topology.js";
import { OutboxDispatcher } from "./outbox.dispatcher.js";
import { OutboxRepository } from "./outbox.repository.js";

const abortController = new AbortController();
const dispatcherId = `outbox-${process.pid}-${randomUUID()}`;

const rabbitMqConnection = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});
const publisher = new RabbitMqPublisher(rabbitMqConnection, {
  exchange: env.RABBITMQ_EXCHANGE,
  confirmTimeoutMs: env.RABBITMQ_CONFIRM_TIMEOUT_MS
});
const repository = new OutboxRepository(pool);
const dispatcher = new OutboxDispatcher(repository, publisher, {
  dispatcherId,
  batchSize: env.OUTBOX_BATCH_SIZE,
  pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
  lockTimeoutMs: env.OUTBOX_LOCK_TIMEOUT_MS,
  retryBaseMs: env.OUTBOX_RETRY_BASE_MS,
  retryMaxMs: env.OUTBOX_RETRY_MAX_MS
});

let shutdownStarted = false;

async function main() {
  registerSignal("SIGINT");
  registerSignal("SIGTERM");

  await rabbitMqConnection.getConfirmChannel();
  await dispatcher.run(abortController.signal);
}

function registerSignal(signal: NodeJS.Signals) {
  process.once(signal, () => {
    if (!shutdownStarted) {
      shutdownStarted = true;
      console.log(`Received ${signal}. Stopping outbox dispatcher...`);
      abortController.abort();
    }
  });
}

main()
  .catch((error) => {
    console.error("Outbox dispatcher failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    abortController.abort();
    await rabbitMqConnection.close();
    await pool.end();
  });
