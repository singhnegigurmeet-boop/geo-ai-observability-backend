import type { ConfirmChannel, GetMessage } from "amqplib";
import pg from "pg";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../../src/db/migration-runner.js";
import {
  QUEUE_NAMES,
  deadLetterQueueName
} from "../../src/messaging/queue-names.js";
import { RabbitMqConnection } from "../../src/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../src/messaging/rabbitmq.topology.js";

export const TEST_MAIN_EXCHANGE = "geo.v6.test.main";
export const TEST_DLX = "geo.v6.test.dlx";

export function createIntegrationPool() {
  return new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ??
      "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test"
  });
}

export function createIntegrationRabbitMq() {
  return new RabbitMqConnection({
    url:
      process.env.TEST_RABBITMQ_URL ??
      "amqp://guest:guest@127.0.0.1:5673?heartbeat=10",
    initializeChannel: (channel) =>
      declareRabbitMqTopology(channel, {
        mainExchange: TEST_MAIN_EXCHANGE,
        deadLetterExchange: TEST_DLX
      })
  });
}

export async function resetTestSchema(pool: pg.Pool) {
  const database = await pool.query<{ name: string }>(
    "SELECT current_database() AS name"
  );
  if (!database.rows[0]?.name.endsWith("_test")) {
    throw new Error("Refusing to reset a non-test database");
  }
  await pool.query("DROP SCHEMA IF EXISTS geo_meta CASCADE");
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations({
    pool,
    migrationsDirectory: getDefaultMigrationsDirectory()
  });
}

export async function truncatePublicTables(pool: pg.Pool) {
  const tables = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  if (tables.rows.length === 0) return;
  await pool.query(
    `TRUNCATE ${tables.rows
      .map((row) => `"${row.tablename}"`)
      .join(", ")} RESTART IDENTITY CASCADE`
  );
}

export async function purgeAllQueues(channel: ConfirmChannel) {
  for (const queue of QUEUE_NAMES) {
    await channel.purgeQueue(queue);
    await channel.purgeQueue(deadLetterQueueName(queue));
  }
}

export async function pollUntil(
  predicate: () => Promise<boolean>,
  description = "integration outcome",
  timeoutMs = 10_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function pollMessage(
  channel: Pick<ConfirmChannel, "get">,
  queue: string,
  timeoutMs = 10_000
): Promise<GetMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await channel.get(queue, { noAck: false });
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for a message on ${queue}`);
}
