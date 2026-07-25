import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../src/db/migration-runner.js";
import { LlmRunWorker } from "../src/llm/llm-run-worker.js";
import type { LlmRunCreatedPayload } from "../src/llm/llm-run-worker.messages.js";
import { deadLetterQueueName } from "../src/messaging/queue-names.js";
import { RabbitMqConnection } from "../src/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../src/messaging/rabbitmq.topology.js";
import {
  PromptPlanningError,
  PromptPlanningService
} from "../src/prompts/prompt-planning.service.js";
import { FailureRecordRepository } from "../src/reliability/failure-record.repository.js";
import { LlmRunWorkerRuntime } from "../src/runtime/llm-run-worker.runtime.js";

const enabled = process.env.RUN_PHASE7_INTEGRATION_TESTS === "true";
const userPromptTypes = [
  "visibility",
  "competitor",
  "ranking",
  "price_range",
  "pros_cons"
] as const;
const anonymousPromptTypes = [
  "visibility",
  "competitor",
  "ranking"
] as const;
const queueByPromptType = {
  competitor: "competitor_prompt_queue",
  ranking: "ranking_prompt_queue",
  visibility: "visibility_prompt_queue",
  price_range: "price_range_prompt_queue",
  pros_cons: "pros_cons_prompt_queue"
} as const;

describe(
  "Phase 7 prompt planning",
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
      await channel.purgeQueue("llm_run_queue");
      await channel.purgeQueue(deadLetterQueueName("llm_run_queue"));
    });

    after(async () => {
      await rabbitMq?.close();
      await pool?.end();
    });

    it("creates the reduced three-job light plan for anonymous work", async () => {
      const fixture = await seedLlmRun(pool, "anonymous");
      const parentBefore = await parentState(pool, fixture);
      const result = await new PromptPlanningService(pool).plan(
        payload(fixture)
      );
      assert.deepEqual(result, { outcome: "planned", promptJobCount: 3 });

      const jobs = await promptJobs(pool, fixture.llmRunId);
      assert.deepEqual(
        jobs.map((job) => job.prompt_type),
        [...anonymousPromptTypes]
      );
      assert.ok(jobs.every((job) => job.prompt_version === "v1_light"));
      assert.ok(jobs.every((job) => job.status === "pending"));
      assert.ok(jobs.every((job) => job.prompt_text === null));
      assert.ok(
        jobs.every(
          (job) =>
            job.idempotency_key ===
            `prompt_job:${fixture.llmRunId}:${job.prompt_type}:v1_light`
        )
      );

      const llm = await llmState(pool, fixture.llmRunId);
      assert.equal(llm.status, "processing");
      assert.ok(llm.started_at);
      assert.equal(llm.error_code, null);
      assert.equal(llm.error_message, null);
      assert.deepEqual(await parentState(pool, fixture), parentBefore);
    });

    it("creates five rich jobs for logged-in and claimed work and preserves claim ownership", async () => {
      const loggedIn = await seedLlmRun(pool, "user");
      assert.deepEqual(
        await new PromptPlanningService(pool).plan(payload(loggedIn)),
        { outcome: "planned", promptJobCount: 5 }
      );
      const loggedJobs = await promptJobs(pool, loggedIn.llmRunId);
      assert.deepEqual(
        loggedJobs.map((job) => job.prompt_type),
        [...userPromptTypes]
      );
      assert.ok(loggedJobs.every((job) => job.prompt_version === "v1"));

      const fixture = await seedLlmRun(pool, "claimed");
      await new PromptPlanningService(pool).plan(payload(fixture));
      const events = await promptOutbox(pool, fixture.llmRunId);
      assert.equal(events.length, 5);
      for (const event of events) {
        const promptType = event.payload.promptType as keyof typeof queueByPromptType;
        assert.equal(
          event.event_key,
          `prompt_job.created:${event.aggregate_id}`
        );
        assert.deepEqual(event.headers, {
          queueName: queueByPromptType[promptType]
        });
        assert.deepEqual(
          Object.keys(event.payload).sort(),
          [
            "promptJobId",
            "llmRunId",
            "analysisRunItemId",
            "analysisRunId",
            "entityPathId",
            "startingEntityPathId",
            "promptType",
            "promptVersion",
            "actorType",
            "userId",
            "workspaceId",
            "anonymousSessionId"
          ].sort()
        );
        assert.equal(event.payload.actorType, "user");
        assert.equal(event.payload.userId, fixture.userId);
        assert.equal(event.payload.workspaceId, fixture.workspaceId);
        assert.equal(
          event.payload.anonymousSessionId,
          fixture.anonymousSessionId
        );
        assert.equal(event.payload.promptVersion, "v1");
        assert.ok(!("promptText" in event.payload));
        assert.ok(!("domain" in event.payload));
      }
    });

    it("rejects authoritative linkage and ownership mismatches and rolls back", async () => {
      const mismatches: Array<
        (valid: LlmRunCreatedPayload) => LlmRunCreatedPayload
      > = [
        (valid) => ({ ...valid, analysisRunItemId: "999" }),
        (valid) => ({ ...valid, analysisRunId: "999" }),
        (valid) => ({ ...valid, entityPathId: "999" }),
        (valid) => ({ ...valid, startingEntityPathId: "999" }),
        (valid) => ({ ...valid, anonymousSessionId: "999" })
      ];
      for (const mismatch of mismatches) {
        const fixture = await seedLlmRun(
          pool,
          "anonymous",
          crypto.randomUUID()
        );
        await assert.rejects(
          new PromptPlanningService(pool).plan(mismatch(payload(fixture))),
          (error: unknown) =>
            error instanceof PromptPlanningError &&
            !("permanent" in error)
        );
        assert.equal((await llmState(pool, fixture.llmRunId)).status, "queued");
        assert.equal((await promptJobs(pool, fixture.llmRunId)).length, 0);
        assert.equal((await promptOutbox(pool, fixture.llmRunId)).length, 0);
      }
    });

    it("is idempotent after planning and ignores terminal redelivery", async () => {
      const fixture = await seedLlmRun(pool, "anonymous");
      const service = new PromptPlanningService(pool);
      await service.plan(payload(fixture));
      assert.deepEqual(await service.plan(payload(fixture)), {
        outcome: "noop",
        promptJobCount: 0
      });
      assert.equal((await promptJobs(pool, fixture.llmRunId)).length, 3);
      assert.equal((await promptOutbox(pool, fixture.llmRunId)).length, 3);

      const terminal = await seedLlmRun(
        pool,
        "anonymous",
        crypto.randomUUID()
      );
      await pool.query(
        `UPDATE llm_runs
         SET status = 'failed', completed_at = now()
         WHERE llm_run_id = $1`,
        [terminal.llmRunId]
      );
      assert.deepEqual(await service.plan(payload(terminal)), {
        outcome: "noop",
        promptJobCount: 0
      });
      assert.equal((await promptJobs(pool, terminal.llmRunId)).length, 0);
    });

    it("rolls back all prompt jobs and outbox events on a technical failure", async () => {
      const fixture = await seedLlmRun(pool, "anonymous");
      await pool.query(`
        CREATE FUNCTION phase7_test_outbox_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test prompt outbox failure'; END $$;
        CREATE TRIGGER phase7_test_outbox_failure_trigger
        BEFORE INSERT ON outbox_events FOR EACH ROW
        WHEN (NEW.event_type = 'prompt_job.created')
        EXECUTE FUNCTION phase7_test_outbox_failure()
      `);
      try {
        await assert.rejects(
          new PromptPlanningService(pool).plan(payload(fixture)),
          /test prompt outbox failure/
        );
        assert.equal((await llmState(pool, fixture.llmRunId)).status, "queued");
        assert.equal((await promptJobs(pool, fixture.llmRunId)).length, 0);
        assert.equal((await promptOutbox(pool, fixture.llmRunId)).length, 0);
      } finally {
        await pool.query(`
          DROP TRIGGER IF EXISTS phase7_test_outbox_failure_trigger ON outbox_events;
          DROP FUNCTION IF EXISTS phase7_test_outbox_failure()
        `);
      }
    });

    it("does not create provider execution, scoring, reporting, or operational records", async () => {
      const fixture = await seedLlmRun(pool, "anonymous");
      await new PromptPlanningService(pool).plan(payload(fixture));
      for (const table of [
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

    it("processes live RabbitMQ work and exhausts failures into the LLM-run DLQ", async () => {
      const fixture = await seedLlmRun(pool, "anonymous");
      const channel = await rabbitMq.getConfirmChannel();
      const successful = new LlmRunWorkerRuntime(
        channel,
        new LlmRunWorker(new PromptPlanningService(pool)),
        new FailureRecordRepository(pool),
        { mainExchange: "geo.v6.test.main", prefetch: 1 },
        { info() {}, warn() {}, error() {} }
      );
      await successful.start();
      await sendEnvelope(channel, envelope(fixture));
      await pollUntil(
        async () => (await llmState(pool, fixture.llmRunId)).status === "processing"
      );
      await successful.stop();

      const failedMessage = {
        ...envelope(fixture),
        messageId: "phase7-exhausted-retry"
      };
      const failing = new LlmRunWorkerRuntime(
        channel,
        {
          async process() {
            throw new Error("simulated Phase 7 technical failure");
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
        deadLetterQueueName("llm_run_queue")
      );
      await failing.stop();
      assert.equal(deadLetter.properties.messageId, failedMessage.messageId);
      channel.ack(deadLetter);
      const failures = await pool.query<{ attempt_number: number }>(
        `SELECT attempt_number FROM failure_records
         WHERE queue_name = 'llm_run_queue' AND message_id = $1
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
  llmRunId: string;
  itemId: string;
  runId: string;
  entityPathId: string;
  startingEntityPathId: string;
  actorType: "anonymous" | "user";
  userId: string | null;
  workspaceId: string | null;
  anonymousSessionId: string | null;
};

async function seedLlmRun(
  pool: pg.Pool,
  ownership: "anonymous" | "user" | "claimed",
  suffix = crypto.randomUUID()
): Promise<Fixture> {
  const domain = await pool.query<{ id: string }>(
    `INSERT INTO domains (normalized_domain)
     VALUES ($1) RETURNING domain_id AS id`,
    [`${suffix}.phase7.example`]
  );
  const entityPath = await pool.query<{ id: string }>(
    `INSERT INTO entity_paths (domain_id, path_type)
     VALUES ($1, 'domain') RETURNING entity_path_id AS id`,
    [domain.rows[0]!.id]
  );
  let userId: string | null = null;
  let workspaceId: string | null = null;
  if (ownership !== "anonymous") {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING user_id AS id`,
      [`${suffix}@phase7.example`]
    );
    userId = user.rows[0]!.id;
    const workspace = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (workspace_name, created_by_user_id)
       VALUES ('Phase 7', $1) RETURNING workspace_id AS id`,
      [userId]
    );
    workspaceId = workspace.rows[0]!.id;
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [workspaceId, userId]
    );
  }
  let anonymousSessionId: string | null = null;
  if (ownership !== "user") {
    const anonymous = await pool.query<{ id: string }>(
      `INSERT INTO anonymous_sessions (
         token_hash, expires_at, claimed_by_user_id, claimed_workspace_id, claimed_at
       )
       VALUES ($1, now() + interval '1 day', $2, $3, $4)
       RETURNING anonymous_session_id AS id`,
      [
        `phase7-${suffix}`,
        userId,
        workspaceId,
        ownership === "claimed" ? new Date() : null
      ]
    );
    anonymousSessionId = anonymous.rows[0]!.id;
  }
  const run = await pool.query<{ id: string }>(
    `INSERT INTO analysis_runs (
       idempotency_key, anonymous_session_id, user_id, workspace_id,
       starting_entity_path_id, requested_provider, requested_model,
       status, request_payload, started_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', '{}'::jsonb, now())
     RETURNING analysis_run_id AS id`,
    [
      `phase7-run-${suffix}`,
      anonymousSessionId,
      userId,
      workspaceId,
      entityPath.rows[0]!.id,
      ownership === "anonymous" ? null : "mock",
      ownership === "anonymous" ? null : "mock-standard"
    ]
  );
  const item = await pool.query<{ id: string }>(
    `INSERT INTO analysis_run_items (
       idempotency_key, analysis_run_id, entity_path_id, item_ordinal,
       status, started_at
     )
     VALUES ($1, $2, $3, 0, 'processing', now())
     RETURNING analysis_run_item_id AS id`,
    [`phase7-item-${suffix}`, run.rows[0]!.id, entityPath.rows[0]!.id]
  );
  const llm = await pool.query<{ id: string }>(
    `INSERT INTO llm_runs (
       idempotency_key, analysis_run_item_id, run_key, status,
       error_code, error_message
     )
     VALUES ($1, $2, 'primary', 'queued', 'STALE', 'stale error')
     RETURNING llm_run_id AS id`,
    [`phase7-llm-${suffix}`, item.rows[0]!.id]
  );
  return {
    llmRunId: llm.rows[0]!.id,
    itemId: item.rows[0]!.id,
    runId: run.rows[0]!.id,
    entityPathId: entityPath.rows[0]!.id,
    startingEntityPathId: entityPath.rows[0]!.id,
    actorType: ownership === "anonymous" ? "anonymous" : "user",
    userId,
    workspaceId,
    anonymousSessionId
  };
}

function payload(fixture: Fixture): LlmRunCreatedPayload {
  return {
    llmRunId: fixture.llmRunId,
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
    messageId: `llm_run.created:${fixture.llmRunId}`,
    eventType: "llm_run.created",
    aggregateType: "llm_run",
    aggregateId: fixture.llmRunId,
    occurredAt: new Date().toISOString(),
    attempt: 1,
    payload: payload(fixture)
  };
}

async function promptJobs(pool: pg.Pool, llmRunId: string) {
  return (
    await pool.query<{
      prompt_job_id: string;
      idempotency_key: string;
      prompt_type: string;
      prompt_version: string;
      status: string;
      prompt_text: string | null;
    }>(
      `SELECT *
       FROM prompt_jobs
       WHERE llm_run_id = $1
       ORDER BY prompt_job_id`,
      [llmRunId]
    )
  ).rows;
}

async function promptOutbox(pool: pg.Pool, llmRunId: string) {
  return (
    await pool.query<{
      event_key: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
      headers: Record<string, unknown>;
    }>(
      `SELECT event.event_key, event.aggregate_id, event.payload, event.headers
       FROM outbox_events AS event
       JOIN prompt_jobs AS prompt
         ON prompt.prompt_job_id = event.aggregate_id::bigint
       WHERE prompt.llm_run_id = $1
         AND event.event_type = 'prompt_job.created'
       ORDER BY prompt.prompt_job_id`,
      [llmRunId]
    )
  ).rows;
}

async function llmState(pool: pg.Pool, llmRunId: string) {
  return (
    await pool.query<{
      status: string;
      started_at: Date | null;
      error_code: string | null;
      error_message: string | null;
    }>("SELECT * FROM llm_runs WHERE llm_run_id = $1", [llmRunId])
  ).rows[0]!;
}

async function parentState(pool: pg.Pool, fixture: Fixture) {
  const item = await pool.query(
    `SELECT status, started_at, completed_at, updated_at
     FROM analysis_run_items WHERE analysis_run_item_id = $1`,
    [fixture.itemId]
  );
  const run = await pool.query(
    `SELECT status, started_at, completed_at, updated_at
     FROM analysis_runs WHERE analysis_run_id = $1`,
    [fixture.runId]
  );
  return { item: item.rows[0], run: run.rows[0] };
}

async function sendEnvelope(
  channel: Awaited<ReturnType<RabbitMqConnection["getConfirmChannel"]>>,
  value: { messageId: string }
) {
  await new Promise<void>((resolve, reject) => {
    channel.publish(
      "geo.v6.test.main",
      "llm_run_queue",
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
  throw new Error("Timed out waiting for Phase 7 worker outcome");
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
