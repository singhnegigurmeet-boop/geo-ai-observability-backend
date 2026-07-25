import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../../../src/common/database/migration-runner.js";
import {
  QUEUE_NAMES,
  deadLetterQueueName
} from "../../../src/common/messaging/queue-names.js";
import { RabbitMqConnection } from "../../../src/common/messaging/rabbitmq.connection.js";
import { RabbitMqPublisher } from "../../../src/common/messaging/rabbitmq.publisher.js";
import { declareRabbitMqTopology } from "../../../src/common/messaging/rabbitmq.topology.js";
import {
  OutboxDispatcher,
  type QueuePublisher
} from "../../../src/modules/outbox/services/outbox.dispatcher.js";
import { OutboxRepository } from "../../../src/modules/outbox/repositories/outbox.repository.js";
import type { OutboxEventRow } from "../../../src/common/types/database.types.js";

const runIntegrationTests =
  process.env.RUN_OUTBOX_RABBITMQ_INTEGRATION_TESTS === "true";
const mainExchange = "geo.v6.test.main";
const deadLetterExchange = "geo.v6.test.dlx";

describe(
    "PostgreSQL outbox and RabbitMQ integration",
  { skip: !runIntegrationTests },
  () => {
    let pool: pg.Pool;
    let rabbitMq: RabbitMqConnection;

    before(async () => {
      const databaseUrl =
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test";
      const rabbitMqUrl =
        process.env.TEST_RABBITMQ_URL ??
        "amqp://guest:guest@127.0.0.1:5673?heartbeat=10";
      pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });

      const database = await pool.query<{ database_name: string }>(
        `SELECT current_database() AS database_name`
      );
      const databaseName = database.rows[0]?.database_name;
      if (!databaseName?.endsWith("_test")) {
        throw new Error(
          `Refusing to reset Outbox database without _test suffix: ${
            databaseName ?? "unknown"
          }`
        );
      }

      await pool.query("DROP SCHEMA IF EXISTS geo_meta CASCADE");
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await runMigrations({
        pool,
        migrationsDirectory: getDefaultMigrationsDirectory()
      });

      rabbitMq = new RabbitMqConnection({
        url: rabbitMqUrl,
        initializeChannel: (channel) =>
          declareRabbitMqTopology(channel, {
            mainExchange,
            deadLetterExchange
          })
      });
      const channel = await rabbitMq.getConfirmChannel();
      for (const queueName of QUEUE_NAMES) {
        await channel.purgeQueue(queueName);
        await channel.purgeQueue(deadLetterQueueName(queueName));
      }
    });

    after(async () => {
      await rabbitMq?.close();
      await pool?.end();
    });

    it("declares all main queues and DLQs and routes rejected messages to the DLQ", async () => {
      const channel = await rabbitMq.getConfirmChannel();
      for (const queueName of QUEUE_NAMES) {
        await channel.checkQueue(queueName);
        await channel.checkQueue(deadLetterQueueName(queueName));
      }

      const queueName = "analysis_run_queue";
      const dlqName = deadLetterQueueName(queueName);
      channel.sendToQueue(queueName, Buffer.from('{"probe":true}'), {
        persistent: true,
        messageId: "dlq-binding-probe"
      });
      await channel.waitForConfirms();

      const delivery = await pollForMessage(channel, queueName);
      channel.nack(delivery, false, false);

      const deadLetter = await pollForMessage(channel, dlqName);
      assert.equal(deadLetter.properties.messageId, "dlq-binding-probe");
      channel.ack(deadLetter);
    });

    it("claims only eligible events and safely divides work between dispatchers", async () => {
      await clearOutbox(pool);
      const now = new Date("2026-01-01T00:00:00.000Z");
      await insertOutboxEvent(pool, "eligible-1", {
        availableAt: new Date(now.getTime() - 1_000)
      });
      await insertOutboxEvent(pool, "eligible-2", {
        availableAt: new Date(now.getTime() - 1_000)
      });
      await insertOutboxEvent(pool, "future", {
        availableAt: new Date(now.getTime() + 60_000)
      });
      await insertOutboxEvent(pool, "stale", {
        status: "publishing",
        lockedAt: new Date(now.getTime() - 120_000),
        lockedBy: "dead-dispatcher"
      });
      await insertOutboxEvent(pool, "active-lease", {
        status: "publishing",
        lockedAt: new Date(now.getTime() - 1_000),
        lockedBy: "active-dispatcher"
      });
      await insertOutboxEvent(pool, "already-published", {
        status: "published",
        publishedAt: new Date(now.getTime() - 1_000)
      });

      const firstRepository = new OutboxRepository(pool);
      const secondRepository = new OutboxRepository(pool);
      const [first, second] = await Promise.all([
        firstRepository.claimBatch({
          dispatcherId: "dispatcher-a",
          batchSize: 2,
          lockTimeoutMs: 60_000,
          now
        }),
        secondRepository.claimBatch({
          dispatcherId: "dispatcher-b",
          batchSize: 2,
          lockTimeoutMs: 60_000,
          now
        })
      ]);

      const eventKeys = [...first, ...second]
        .map((event) => event.event_key)
        .sort();
      assert.deepEqual(eventKeys, ["eligible-1", "eligible-2", "stale"]);
      assert.equal(new Set(eventKeys).size, eventKeys.length);
      assert.ok(
        [...first, ...second].every(
          (event) =>
            event.status === "publishing" &&
            event.attempt_count === 1 &&
            event.locked_at?.toISOString() === now.toISOString()
        )
      );
    });

    it("marks an event published only after a broker confirm and skips it on rerun", async () => {
      await clearOutbox(pool);
      await purgeQueue(rabbitMq, "analysis_run_queue");
      const eventId = await insertOutboxEvent(pool, "publish-success");
      const repository = new OutboxRepository(pool);
      const publisher = new RabbitMqPublisher(rabbitMq, {
        exchange: mainExchange,
        confirmTimeoutMs: 10_000
      });
      const dispatcher = createDispatcher(repository, publisher, "publisher-a");

      assert.equal(await dispatcher.dispatchBatch(), 1);
      const row = await getOutboxEvent(pool, eventId);
      assert.equal(row.status, "published");
      assert.ok(row.published_at);
      assert.equal(row.locked_at, null);
      assert.equal(row.locked_by, null);

      const channel = await rabbitMq.getConfirmChannel();
      const delivery = await pollForMessage(channel, "analysis_run_queue");
      const envelope = JSON.parse(delivery.content.toString()) as {
        messageId: string;
        eventType: string;
        aggregateType: string;
        aggregateId: string;
        occurredAt: string;
        attempt: number;
        payload: { analysisRunId: string };
      };
      assert.equal(envelope.messageId, "publish-success");
      assert.equal(envelope.eventType, "analysis_run.created");
      assert.equal(envelope.aggregateType, "analysis_run");
      assert.equal(envelope.aggregateId, "42");
      assert.match(envelope.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(envelope.attempt, 1);
      assert.deepEqual(envelope.payload, { analysisRunId: "42" });
      channel.ack(delivery);

      assert.equal(await dispatcher.dispatchBatch(), 0);
      const queueState = await channel.checkQueue("analysis_run_queue");
      assert.equal(queueState.messageCount, 0);
    });

    it("leaves failed publications retryable without immediate duplicate selection", async () => {
      await clearOutbox(pool);
      const eventId = await insertOutboxEvent(pool, "publish-failure");
      const repository = new OutboxRepository(pool);
      let publishCalls = 0;
      const failingPublisher: QueuePublisher = {
        async publish() {
          publishCalls += 1;
          const error = new Error("simulated broker failure") as Error & {
            code: string;
          };
          error.code = "SIMULATED_BROKER_FAILURE";
          throw error;
        }
      };
      const dispatcher = createDispatcher(
        repository,
        failingPublisher,
        "publisher-failure",
        () => new Date("2026-01-01T00:00:00.000Z")
      );

      assert.equal(await dispatcher.dispatchBatch(), 1);
      const row = await getOutboxEvent(pool, eventId);
      assert.equal(row.status, "failed");
      assert.equal(row.attempt_count, 1);
      assert.equal(row.last_error_code, "SIMULATED_BROKER_FAILURE");
      assert.equal(row.last_error_message, "simulated broker failure");
      assert.equal(row.available_at.toISOString(), "2026-01-01T00:00:01.000Z");
      assert.equal(row.locked_at, null);
      assert.equal(row.locked_by, null);

      assert.equal(await dispatcher.dispatchBatch(), 0);
      assert.equal(publishCalls, 1);
    });
  }
);

function createDispatcher(
  repository: OutboxRepository,
  publisher: QueuePublisher,
  dispatcherId: string,
  now: () => Date = () => new Date()
) {
  return new OutboxDispatcher(
    repository,
    publisher,
    {
      dispatcherId,
      batchSize: 10,
      pollIntervalMs: 50,
      lockTimeoutMs: 60_000,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000
    },
    {
      info() {},
      warn() {},
      error() {}
    },
    now
  );
}

async function insertOutboxEvent(
  pool: pg.Pool,
  eventKey: string,
  options: {
    status?: "pending" | "publishing" | "published" | "failed";
    availableAt?: Date;
    lockedAt?: Date;
    lockedBy?: string;
    publishedAt?: Date;
  } = {}
) {
  const result = await pool.query<{ outbox_event_id: string }>(
    `
      INSERT INTO outbox_events (
        event_key,
        aggregate_type,
        aggregate_id,
        event_type,
        payload,
        headers,
        status,
        available_at,
        locked_at,
        locked_by,
        published_at
      )
      VALUES (
        $1,
        'analysis_run',
        '42',
        'analysis_run.created',
        '{"analysisRunId":"42"}'::jsonb,
        '{"queueName":"analysis_run_queue"}'::jsonb,
        $2,
        $3,
        $4,
        $5,
        $6
      )
      RETURNING outbox_event_id
    `,
    [
      eventKey,
      options.status ?? "pending",
      options.availableAt ?? new Date("2025-12-31T23:59:59.000Z"),
      options.lockedAt ?? null,
      options.lockedBy ?? null,
      options.publishedAt ?? null
    ]
  );
  const eventId = result.rows[0]?.outbox_event_id;
  if (!eventId) {
    throw new Error("Outbox insert did not return an ID");
  }
  return eventId;
}

async function getOutboxEvent(pool: pg.Pool, eventId: string) {
  const result = await pool.query<OutboxEventRow>(
    "SELECT * FROM outbox_events WHERE outbox_event_id = $1",
    [eventId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Outbox event ${eventId} was not found`);
  }
  return row;
}

async function clearOutbox(pool: pg.Pool) {
  await pool.query("DELETE FROM outbox_events");
}

async function purgeQueue(
  rabbitMq: RabbitMqConnection,
  queueName: (typeof QUEUE_NAMES)[number]
) {
  const channel = await rabbitMq.getConfirmChannel();
  await channel.purgeQueue(queueName);
  await channel.purgeQueue(deadLetterQueueName(queueName));
}

async function pollForMessage(
  channel: Awaited<ReturnType<RabbitMqConnection["getConfirmChannel"]>>,
  queueName: string
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const message = await channel.get(queueName, { noAck: false });
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for a message in ${queueName}`);
}
