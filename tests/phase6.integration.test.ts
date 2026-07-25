import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { AnalysisRunItemWorker } from "../src/analysis/analysis-run-item-worker.js";
import type { AnalysisRunItemCreatedPayload } from "../src/analysis/analysis-run-item-worker.messages.js";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../src/db/migration-runner.js";
import {
  LlmRunCreationError,
  LlmRunCreationService
} from "../src/llm/llm-run-creation.service.js";
import { deadLetterQueueName } from "../src/messaging/queue-names.js";
import { RabbitMqConnection } from "../src/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../src/messaging/rabbitmq.topology.js";
import { FailureRecordRepository } from "../src/reliability/failure-record.repository.js";
import { AnalysisRunItemWorkerRuntime } from "../src/runtime/analysis-run-item-worker.runtime.js";

const enabled = process.env.RUN_PHASE6_INTEGRATION_TESTS === "true";

describe(
  "Phase 6 LLM run creation",
  { skip: !enabled, concurrency: 1 },
  () => {
    let pool: pg.Pool;
    let rabbitMq: RabbitMqConnection;

    before(async () => {
      pool = new pg.Pool({
        connectionString:
          process.env.TEST_DATABASE_URL ??
          "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test",
        max: 8
      });
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
      rabbitMq = new RabbitMqConnection({
        url:
          process.env.TEST_RABBITMQ_URL ??
          "amqp://guest:guest@127.0.0.1:5673?heartbeat=10",
        initializeChannel: (channel) =>
          declareRabbitMqTopology(channel, {
            mainExchange: "geo.v6.test.main",
            deadLetterExchange: "geo.v6.test.dlx"
          })
      });
      await rabbitMq.getConfirmChannel();
    });

    beforeEach(async () => {
      const tables = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
      );
      await pool.query(
        `TRUNCATE ${tables.rows
          .map((row) => `"${row.tablename}"`)
          .join(", ")} RESTART IDENTITY CASCADE`
      );
      const channel = await rabbitMq.getConfirmChannel();
      await channel.purgeQueue("analysis_run_item_queue");
      await channel.purgeQueue(
        deadLetterQueueName("analysis_run_item_queue")
      );
    });

    after(async () => {
      await rabbitMq?.close();
      await pool?.end();
    });

    it("creates one queued LLM run and ID-only outbox event, then marks the item processing", async () => {
      const fixture = await seedItem(pool, "anonymous");
      const parentBefore = await parentState(pool, fixture.runId);
      const result = await new LlmRunCreationService(pool).create(
        payload(fixture)
      );
      assert.equal(result.outcome, "created");

      const runs = await llmRuns(pool, fixture.itemId);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.idempotency_key, `llm_run:${fixture.itemId}`);
      assert.equal(runs[0]?.run_key, "primary");
      assert.equal(runs[0]?.status, "queued");

      const item = await itemState(pool, fixture.itemId);
      assert.equal(item.status, "processing");
      assert.ok(item.started_at);
      assert.equal(item.error_code, null);
      assert.equal(item.error_message, null);
      assert.deepEqual(await parentState(pool, fixture.runId), parentBefore);

      const event = await llmOutbox(pool, fixture.itemId);
      assert.equal(event.length, 1);
      assert.deepEqual(event[0]?.headers, { queueName: "llm_run_queue" });
      assert.deepEqual(
        Object.keys(event[0]?.payload ?? {}).sort(),
        [
          "llmRunId",
          "analysisRunItemId",
          "analysisRunId",
          "entityPathId",
          "startingEntityPathId",
          "actorType",
          "userId",
          "workspaceId",
          "anonymousSessionId"
        ].sort()
      );
      assert.ok(
        Object.values(event[0]?.payload ?? {}).every(
          (value) => value === null || typeof value === "string"
        )
      );
    });

    it("preserves claimed ownership IDs in the LLM-run event", async () => {
      const fixture = await seedItem(pool, "claimed");
      await new LlmRunCreationService(pool).create(payload(fixture));
      const event = (await llmOutbox(pool, fixture.itemId))[0]!.payload;
      assert.equal(event.actorType, "user");
      assert.equal(event.userId, fixture.userId);
      assert.equal(event.workspaceId, fixture.workspaceId);
      assert.equal(event.anonymousSessionId, fixture.anonymousSessionId);
    });

    it("rejects run and path payload mismatches as retryable technical errors", async () => {
      for (const mismatch of [
        { analysisRunId: "999" },
        { entityPathId: "999" }
      ]) {
        const fixture = await seedItem(
          pool,
          "anonymous",
          crypto.randomUUID()
        );
        await assert.rejects(
          new LlmRunCreationService(pool).create({
            ...payload(fixture),
            ...mismatch
          }),
          (error: unknown) =>
            error instanceof LlmRunCreationError &&
            !("permanent" in error)
        );
        assert.equal((await itemState(pool, fixture.itemId)).status, "queued");
        assert.equal((await llmRuns(pool, fixture.itemId)).length, 0);
      }
    });

    it("is idempotent after processing and ignores terminal redelivery", async () => {
      const fixture = await seedItem(pool, "anonymous");
      const service = new LlmRunCreationService(pool);
      await service.create(payload(fixture));
      assert.deepEqual(await service.create(payload(fixture)), {
        outcome: "noop",
        llmRunId: null
      });
      assert.equal((await llmRuns(pool, fixture.itemId)).length, 1);
      assert.equal((await llmOutbox(pool, fixture.itemId)).length, 1);

      const terminal = await seedItem(
        pool,
        "anonymous",
        crypto.randomUUID()
      );
      await pool.query(
        `UPDATE analysis_run_items
         SET status = 'failed', completed_at = now()
         WHERE analysis_run_item_id = $1`,
        [terminal.itemId]
      );
      assert.deepEqual(await service.create(payload(terminal)), {
        outcome: "noop",
        llmRunId: null
      });
      assert.equal((await llmRuns(pool, terminal.itemId)).length, 0);
    });

    it("rolls back LLM run and outbox creation and leaves the item queued on technical failure", async () => {
      const fixture = await seedItem(pool, "anonymous");
      await pool.query(`
        CREATE FUNCTION phase6_test_outbox_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test LLM outbox failure'; END $$;
        CREATE TRIGGER phase6_test_outbox_failure_trigger
        BEFORE INSERT ON outbox_events FOR EACH ROW
        WHEN (NEW.event_type = 'llm_run.created')
        EXECUTE FUNCTION phase6_test_outbox_failure()
      `);
      await assert.rejects(
        new LlmRunCreationService(pool).create(payload(fixture)),
        /test LLM outbox failure/
      );
      assert.equal((await itemState(pool, fixture.itemId)).status, "queued");
      assert.equal((await llmRuns(pool, fixture.itemId)).length, 0);
      assert.equal((await llmOutbox(pool, fixture.itemId)).length, 0);
      await pool.query(`
        DROP TRIGGER phase6_test_outbox_failure_trigger ON outbox_events;
        DROP FUNCTION phase6_test_outbox_failure()
      `);
    });

    it("rejects an inactive item path without creating downstream state", async () => {
      const fixture = await seedItem(pool, "anonymous");
      await pool.query(
        "UPDATE entity_paths SET is_active = false WHERE entity_path_id = $1",
        [fixture.entityPathId]
      );
      await assert.rejects(
        new LlmRunCreationService(pool).create(payload(fixture)),
        (error: unknown) =>
          error instanceof LlmRunCreationError &&
          error.code === "ITEM_ENTITY_PATH_NOT_FOUND"
      );
      assert.equal((await itemState(pool, fixture.itemId)).status, "queued");
      assert.equal((await llmRuns(pool, fixture.itemId)).length, 0);
    });

    it("does not create prompt or downstream provider/report records", async () => {
      const fixture = await seedItem(pool, "anonymous");
      await new LlmRunCreationService(pool).create(payload(fixture));
      for (const table of [
        "prompt_jobs",
        "provider_jobs",
        "provider_results",
        "token_usage",
        "provider_scores",
        "reports",
        "budget_policies",
        "scheduler_jobs",
        "notifications"
      ]) {
        const count = await pool.query<{ count: string }>(
          `SELECT count(*) FROM ${table}`
        );
        assert.equal(count.rows[0]?.count, "0", table);
      }
    });

    it("processes live RabbitMQ work and exhausts failures into the item DLQ", async () => {
      const fixture = await seedItem(pool, "anonymous");
      const channel = await rabbitMq.getConfirmChannel();
      const successful = new AnalysisRunItemWorkerRuntime(
        channel,
        new AnalysisRunItemWorker(new LlmRunCreationService(pool)),
        new FailureRecordRepository(pool),
        { mainExchange: "geo.v6.test.main", prefetch: 1 },
        { info() {}, warn() {}, error() {} }
      );
      await successful.start();
      await sendEnvelope(channel, envelope(fixture));
      await pollUntil(
        async () => (await itemState(pool, fixture.itemId)).status === "processing"
      );
      await successful.stop();

      const failedMessage = {
        ...envelope(fixture),
        messageId: "phase6-exhausted-retry"
      };
      const failing = new AnalysisRunItemWorkerRuntime(
        channel,
        {
          async process() {
            throw new Error("simulated Phase 6 technical failure");
          }
        },
        new FailureRecordRepository(pool),
        { mainExchange: "geo.v6.test.main", prefetch: 1 },
        { info() {}, warn() {}, error() {} }
      );
      await failing.start();
      await sendEnvelope(channel, failedMessage);
      const deadLetter = await pollMessage(
        channel,
        deadLetterQueueName("analysis_run_item_queue")
      );
      await failing.stop();
      assert.equal(deadLetter.properties.messageId, failedMessage.messageId);
      channel.ack(deadLetter);
      const failures = await pool.query<{ attempt_number: number }>(
        `SELECT attempt_number FROM failure_records
         WHERE queue_name = 'analysis_run_item_queue' AND message_id = $1
         ORDER BY attempt_number`,
        [failedMessage.messageId]
      );
      assert.deepEqual(
        failures.rows.map((row) => row.attempt_number),
        [1, 2, 3]
      );
    });
  }
);

type Fixture = {
  itemId: string;
  runId: string;
  entityPathId: string;
  startingEntityPathId: string;
  actorType: "anonymous" | "user";
  userId: string | null;
  workspaceId: string | null;
  anonymousSessionId: string | null;
};

async function seedItem(
  pool: pg.Pool,
  ownership: "anonymous" | "claimed",
  suffix = crypto.randomUUID()
): Promise<Fixture> {
  const domain = await pool.query<{ id: string }>(
    `INSERT INTO domains (normalized_domain)
     VALUES ($1) RETURNING domain_id AS id`,
    [`${suffix}.phase6.example`]
  );
  const entityPath = await pool.query<{ id: string }>(
    `INSERT INTO entity_paths (domain_id, path_type)
     VALUES ($1, 'domain') RETURNING entity_path_id AS id`,
    [domain.rows[0]!.id]
  );
  let userId: string | null = null;
  let workspaceId: string | null = null;
  if (ownership === "claimed") {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING user_id AS id`,
      [`${suffix}@phase6.example`]
    );
    userId = user.rows[0]!.id;
    const workspace = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (workspace_name, created_by_user_id)
       VALUES ('Phase 6', $1) RETURNING workspace_id AS id`,
      [userId]
    );
    workspaceId = workspace.rows[0]!.id;
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [workspaceId, userId]
    );
  }
  const anonymous = await pool.query<{ id: string }>(
    `INSERT INTO anonymous_sessions (
       token_hash, expires_at, claimed_by_user_id, claimed_workspace_id, claimed_at
     )
     VALUES ($1, now() + interval '1 day', $2, $3, $4)
     RETURNING anonymous_session_id AS id`,
    [
      `phase6-${suffix}`,
      userId,
      workspaceId,
      ownership === "claimed" ? new Date() : null
    ]
  );
  const run = await pool.query<{ id: string }>(
    `INSERT INTO analysis_runs (
       idempotency_key, anonymous_session_id, user_id, workspace_id,
       starting_entity_path_id, status, request_payload, started_at
     )
     VALUES ($1, $2, $3, $4, $5, 'processing', '{}'::jsonb, now())
     RETURNING analysis_run_id AS id`,
    [
      `phase6-run-${suffix}`,
      anonymous.rows[0]!.id,
      userId,
      workspaceId,
      entityPath.rows[0]!.id
    ]
  );
  const item = await pool.query<{ id: string }>(
    `INSERT INTO analysis_run_items (
       idempotency_key, analysis_run_id, entity_path_id, item_ordinal,
       status, error_code, error_message
     )
     VALUES ($1, $2, $3, 0, 'queued', 'STALE', 'stale error')
     RETURNING analysis_run_item_id AS id`,
    [
      `phase6-item-${suffix}`,
      run.rows[0]!.id,
      entityPath.rows[0]!.id
    ]
  );
  return {
    itemId: item.rows[0]!.id,
    runId: run.rows[0]!.id,
    entityPathId: entityPath.rows[0]!.id,
    startingEntityPathId: entityPath.rows[0]!.id,
    actorType: ownership === "claimed" ? "user" : "anonymous",
    userId,
    workspaceId,
    anonymousSessionId: anonymous.rows[0]!.id
  };
}

function payload(fixture: Fixture): AnalysisRunItemCreatedPayload {
  return {
    analysisRunItemId: fixture.itemId,
    analysisRunId: fixture.runId,
    entityPathId: fixture.entityPathId,
    startingEntityPathId: fixture.startingEntityPathId,
    actorType: fixture.actorType,
    userId: fixture.userId,
    workspaceId: fixture.workspaceId,
    anonymousSessionId: fixture.anonymousSessionId
  };
}

function envelope(fixture: Fixture) {
  return {
    messageId: `analysis_run_item.created:${fixture.itemId}`,
    eventType: "analysis_run_item.created",
    aggregateType: "analysis_run_item",
    aggregateId: fixture.itemId,
    occurredAt: new Date().toISOString(),
    attempt: 1,
    payload: payload(fixture)
  };
}

async function llmRuns(pool: pg.Pool, itemId: string) {
  return (
    await pool.query<{
      idempotency_key: string;
      run_key: string;
      status: string;
    }>("SELECT * FROM llm_runs WHERE analysis_run_item_id = $1", [itemId])
  ).rows;
}

async function llmOutbox(pool: pg.Pool, itemId: string) {
  return (
    await pool.query<{
      payload: Record<string, unknown>;
      headers: Record<string, unknown>;
    }>(
      `SELECT event.payload, event.headers
       FROM outbox_events AS event
       JOIN llm_runs AS llm ON llm.llm_run_id = event.aggregate_id::bigint
       WHERE llm.analysis_run_item_id = $1
         AND event.event_type = 'llm_run.created'`,
      [itemId]
    )
  ).rows;
}

async function itemState(pool: pg.Pool, itemId: string) {
  return (
    await pool.query<{
      status: string;
      started_at: Date | null;
      error_code: string | null;
      error_message: string | null;
    }>("SELECT * FROM analysis_run_items WHERE analysis_run_item_id = $1", [
      itemId
    ])
  ).rows[0]!;
}

async function parentState(pool: pg.Pool, runId: string) {
  return (
    await pool.query<{
      status: string;
      started_at: Date | null;
      completed_at: Date | null;
      updated_at: Date;
    }>(
      `SELECT status, started_at, completed_at, updated_at
       FROM analysis_runs WHERE analysis_run_id = $1`,
      [runId]
    )
  ).rows[0]!;
}

async function sendEnvelope(
  channel: Awaited<ReturnType<RabbitMqConnection["getConfirmChannel"]>>,
  value: { messageId: string }
) {
  await new Promise<void>((resolve, reject) => {
    channel.publish(
      "geo.v6.test.main",
      "analysis_run_item_queue",
      Buffer.from(JSON.stringify(value)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: value.messageId
      },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

async function pollUntil(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Phase 6 worker outcome");
}

async function pollMessage(
  channel: Awaited<ReturnType<RabbitMqConnection["getConfirmChannel"]>>,
  queue: string
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const message = await channel.get(queue, { noAck: false });
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${queue}`);
}
