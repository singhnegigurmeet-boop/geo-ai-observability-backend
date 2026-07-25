import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../src/db/migration-runner.js";
import { deadLetterQueueName } from "../src/messaging/queue-names.js";
import { RabbitMqConnection } from "../src/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../src/messaging/rabbitmq.topology.js";
import { MockProviderService } from "../src/providers/mock-provider.service.js";
import { MockProviderWorker } from "../src/providers/mock-provider-worker.js";
import type { ProviderJobCreatedPayload } from "../src/providers/provider-worker.messages.js";
import {
  PromptExecutionError,
  PromptExecutionService
} from "../src/prompts/prompt-execution.service.js";
import type { PromptJobCreatedPayload } from "../src/prompts/prompt-worker.messages.js";
import { PromptWorker } from "../src/prompts/prompt-worker.js";
import { FailureRecordRepository } from "../src/reliability/failure-record.repository.js";
import { MockProviderWorkerRuntime } from "../src/runtime/mock-provider-worker.runtime.js";
import { PromptWorkerRuntime } from "../src/runtime/prompt-worker.runtime.js";
import type { PromptType } from "../src/types/database.types.js";

const enabled = process.env.RUN_PHASE8_INTEGRATION_TESTS === "true";
const userPromptTypes: PromptType[] = [
  "visibility",
  "competitor",
  "ranking",
  "price_range",
  "pros_cons"
];
const anonymousPromptTypes: PromptType[] = [
  "visibility",
  "competitor",
  "ranking"
];

describe(
  "Phase 8 prompt rendering and mock provider execution",
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
      for (const queue of [
        "competitor_prompt_queue",
        "ranking_prompt_queue",
        "visibility_prompt_queue",
        "price_range_prompt_queue",
        "pros_cons_prompt_queue",
        "mock_queue"
      ] as const) {
        await channel.purgeQueue(queue);
        await channel.purgeQueue(deadLetterQueueName(queue));
      }
    });

    after(async () => {
      await rabbitMq?.close();
      await pool?.end();
    });

    it("renders reduced anonymous prompts with mock-fast and rich user prompts with mock-standard", async () => {
      for (const promptType of anonymousPromptTypes) {
        const fixture = await seedPrompt(
          pool,
          promptType,
          "anonymous",
          crypto.randomUUID()
        );
        const result = await new PromptExecutionService(pool).execute(
          promptPayload(fixture)
        );
        assert.equal(result.outcome, "enqueued");

        const prompt = await promptState(pool, fixture.promptJobId);
        assert.equal(prompt.status, "processing");
        assert.ok(prompt.prompt_text?.trim());
        assert.match(prompt.prompt_text!, /domain=phase8-[\w-]+\.example/);
        assert.doesNotMatch(prompt.prompt_text!, /RAW-USER-INPUT/);

        const jobs = await providerJobs(pool, fixture.promptJobId);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.provider, "mock");
        assert.equal(jobs[0]?.model, "mock-fast");
        assert.equal(jobs[0]?.status, "queued");
        assert.equal(
          jobs[0]?.idempotency_key,
          `provider_job:${fixture.promptJobId}:mock:mock-fast`
        );
        const event = await providerOutbox(pool, jobs[0]!.provider_job_id);
        assert.equal(event.event_key, `provider_job.created:${jobs[0]!.provider_job_id}`);
        assert.deepEqual(event.headers, { queueName: "mock_queue" });
        assert.deepEqual(event.payload, {
          providerJobId: jobs[0]!.provider_job_id,
          promptJobId: fixture.promptJobId,
          provider: "mock",
          model: "mock-fast"
        });

        assert.deepEqual(
          await new PromptExecutionService(pool).execute(promptPayload(fixture)),
          { outcome: "noop", providerJobId: null }
        );
        assert.equal((await providerJobs(pool, fixture.promptJobId)).length, 1);
      }

      for (const promptType of userPromptTypes) {
        const fixture = await seedPrompt(
          pool,
          promptType,
          "user",
          crypto.randomUUID()
        );
        await new PromptExecutionService(pool).execute(promptPayload(fixture));
        const prompt = await promptState(pool, fixture.promptJobId);
        assert.equal(prompt.status, "processing");
        assert.ok(prompt.prompt_text?.trim());
        assert.match(prompt.prompt_text!, /actor_policy=user/);
        const job = (await providerJobs(pool, fixture.promptJobId))[0]!;
        assert.equal(job.provider, "mock");
        assert.equal(job.model, "mock-standard");
        assert.equal(
          job.idempotency_key,
          `provider_job:${fixture.promptJobId}:mock:mock-standard`
        );
      }
    });

    it("renders claimed work with user policy while preserving its anonymous origin validation", async () => {
      const fixture = await seedPrompt(pool, "visibility", "claimed");
      await new PromptExecutionService(pool).execute(promptPayload(fixture));
      const prompt = await promptState(pool, fixture.promptJobId);
      assert.match(prompt.prompt_text!, /actor_policy=user/);
      assert.equal(fixture.actorType, "user");
      assert.ok(fixture.anonymousSessionId);
      assert.equal(
        (await providerJobs(pool, fixture.promptJobId))[0]?.model,
        "mock-standard"
      );
    });

    it("rejects message-state mismatches and blank rendering with complete rollback", async () => {
      const fixture = await seedPrompt(pool, "ranking", "anonymous");
      await assert.rejects(
        new PromptExecutionService(pool).execute({
          ...promptPayload(fixture),
          analysisRunId: "999"
        }),
        PromptExecutionError
      );
      assert.equal((await promptState(pool, fixture.promptJobId)).prompt_text, null);
      assert.equal((await providerJobs(pool, fixture.promptJobId)).length, 0);

      await assert.rejects(
        new PromptExecutionService(pool, {
          render() {
            return "   ";
          }
        }).execute(promptPayload(fixture)),
        (error: unknown) =>
          error instanceof PromptExecutionError &&
          error.code === "BLANK_RENDERED_PROMPT"
      );
      assert.equal((await promptState(pool, fixture.promptJobId)).prompt_text, null);
      assert.equal((await providerJobs(pool, fixture.promptJobId)).length, 0);
    });

    it("stores immutable deterministic evidence and actual token usage exactly once", async () => {
      const fixture = await seedPrompt(
        pool,
        "pros_cons",
        "user",
        crypto.randomUUID(),
        "mock-quality"
      );
      const planned = await new PromptExecutionService(pool).execute(
        promptPayload(fixture)
      );
      assert.equal(planned.outcome, "enqueued");
      if (planned.outcome !== "enqueued") return;
      const payload = providerPayload(fixture, planned.providerJobId);

      const completed = await new MockProviderService(pool).execute(payload);
      assert.equal(completed.outcome, "completed");
      const result = await providerResult(pool, planned.providerJobId);
      assert.equal(result.provider, "mock");
      assert.equal(result.status, "valid");
      assert.equal(result.model_version, "mock-quality");
      assert.equal(result.parsed_response.provider, "mock");
      assert.equal(result.parsed_response.model, "mock-quality");
      assert.equal(result.parsed_response.promptType, "pros_cons");
      assert.equal(result.latency_ms, 0);

      const usage = await tokenUsage(pool, planned.providerJobId);
      assert.equal(usage.length, 1);
      assert.equal(usage[0]?.usage_kind, "actual");
      assert.ok(Number(usage[0]?.input_tokens) > 0);
      assert.equal(usage[0]?.output_tokens, "32");
      assert.equal(usage[0]?.cost_micros, "0");
      assert.equal((await promptState(pool, fixture.promptJobId)).status, "succeeded");
      assert.equal((await providerJobs(pool, fixture.promptJobId))[0]?.status, "succeeded");
      const scoreEvent = await pool.query<{
        event_key: string;
        payload: Record<string, unknown>;
        headers: Record<string, unknown>;
      }>(
        `
          SELECT event_key, payload, headers
          FROM outbox_events
          WHERE event_type = 'provider_result.created'
            AND aggregate_id = $1
        `,
        [completed.providerResultId]
      );
      assert.equal(
        scoreEvent.rows[0]?.event_key,
        `provider_result.created:${completed.providerResultId}`
      );
      assert.deepEqual(scoreEvent.rows[0]?.headers, {
        queueName: "scoring_queue"
      });
      assert.deepEqual(scoreEvent.rows[0]?.payload, {
        providerResultId: completed.providerResultId,
        providerJobId: planned.providerJobId,
        promptJobId: fixture.promptJobId,
        analysisRunId: fixture.runId
      });

      assert.deepEqual(await new MockProviderService(pool).execute(payload), {
        outcome: "noop",
        providerResultId: null
      });
      assert.equal((await tokenUsage(pool, planned.providerJobId)).length, 1);
      assert.equal(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*) FROM provider_results WHERE provider_job_id = $1",
            [planned.providerJobId]
          )
        ).rows[0]?.count,
        "1"
      );
    });

    it("rejects provider-job creation for an unrendered prompt at the database boundary", async () => {
      const fixture = await seedPrompt(pool, "competitor", "anonymous");
      await assert.rejects(
        insertProviderJob(pool, fixture.promptJobId),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23514"
      );
      assert.equal((await providerJobs(pool, fixture.promptJobId)).length, 0);
      assert.equal(
        Number(
          (
            await pool.query<{ count: string }>(
              `SELECT count(*) FROM provider_results AS result
               JOIN provider_jobs AS job
                 ON job.provider_job_id = result.provider_job_id
               WHERE job.prompt_job_id = $1`,
              [fixture.promptJobId]
            )
          ).rows[0]!.count
        ),
        0
      );
    });

    it("rolls provider evidence, usage, and status back together on technical failure", async () => {
      const fixture = await seedPrompt(pool, "price_range", "user");
      const planned = await new PromptExecutionService(pool).execute(
        promptPayload(fixture)
      );
      if (planned.outcome !== "enqueued") assert.fail("provider job not created");
      await pool.query(`
        CREATE FUNCTION phase8_test_usage_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test usage failure'; END $$;
        CREATE TRIGGER phase8_test_usage_failure_trigger
        BEFORE INSERT ON token_usage FOR EACH ROW
        EXECUTE FUNCTION phase8_test_usage_failure()
      `);
      try {
        await assert.rejects(
          new MockProviderService(pool).execute(
            providerPayload(fixture, planned.providerJobId)
          ),
          /test usage failure/
        );
        assert.equal(await evidenceCount(pool, planned.providerJobId), 0);
        assert.equal((await tokenUsage(pool, planned.providerJobId)).length, 0);
        assert.equal((await providerJobs(pool, fixture.promptJobId))[0]?.status, "queued");
        assert.equal((await promptState(pool, fixture.promptJobId)).status, "processing");
      } finally {
        await pool.query(`
          DROP TRIGGER IF EXISTS phase8_test_usage_failure_trigger ON token_usage;
          DROP FUNCTION IF EXISTS phase8_test_usage_failure()
        `);
      }
    });

    it("runs the live prompt-to-mock evidence path through dedicated queues", async () => {
      const fixture = await seedPrompt(pool, "visibility", "anonymous");
      const channel = await rabbitMq.getConfirmChannel();
      const promptRuntime = new PromptWorkerRuntime(
        channel,
        new PromptWorker(
          "visibility",
          new PromptExecutionService(pool)
        ),
        new FailureRecordRepository(pool),
        {
          queueName: "visibility_prompt_queue",
          mainExchange: "geo.v6.test.main",
          prefetch: 1
        },
        quietLogger
      );
      const mockRuntime = new MockProviderWorkerRuntime(
        channel,
        new MockProviderWorker(new MockProviderService(pool)),
        new FailureRecordRepository(pool),
        { mainExchange: "geo.v6.test.main", prefetch: 1 },
        quietLogger
      );
      await promptRuntime.start();
      await sendEnvelope(channel, "visibility_prompt_queue", promptEnvelope(fixture));
      await pollUntil(async () => {
        const jobs = await providerJobs(pool, fixture.promptJobId);
        return jobs[0]?.status === "queued";
      });
      await promptRuntime.stop();
      const providerJob = (await providerJobs(pool, fixture.promptJobId))[0]!;
      const event = await providerOutbox(pool, providerJob.provider_job_id);

      await mockRuntime.start();
      await sendEnvelope(channel, "mock_queue", {
        messageId: event.event_key,
        eventType: "provider_job.created",
        aggregateType: "provider_job",
        aggregateId: providerJob.provider_job_id,
        occurredAt: new Date().toISOString(),
        attempt: 1,
        payload: event.payload
      });
      await pollUntil(
        async () => (await providerJobs(pool, fixture.promptJobId))[0]?.status === "succeeded"
      );
      await mockRuntime.stop();
      assert.equal(await evidenceCount(pool, providerJob.provider_job_id), 1);
      assert.equal((await tokenUsage(pool, providerJob.provider_job_id)).length, 1);
    });

    it("dead-letters malformed prompt messages and exhausted technical mock failures", async () => {
      const channel = await rabbitMq.getConfirmChannel();
      const malformedRuntime = new PromptWorkerRuntime(
        channel,
        new PromptWorker("visibility", new PromptExecutionService(pool)),
        new FailureRecordRepository(pool),
        {
          queueName: "visibility_prompt_queue",
          mainExchange: "geo.v6.test.main",
          prefetch: 1
        },
        quietLogger
      );
      await malformedRuntime.start();
      await sendEnvelope(channel, "visibility_prompt_queue", {
        messageId: "phase8-malformed",
        wrong: true
      });
      const malformed = await pollMessage(
        channel,
        deadLetterQueueName("visibility_prompt_queue")
      );
      await malformedRuntime.stop();
      assert.equal(malformed.properties.messageId, "phase8-malformed");
      channel.ack(malformed);

      const failing = new MockProviderWorkerRuntime(
        channel,
        {
          async process() {
            throw new Error("simulated Phase 8 provider failure");
          }
        },
        new FailureRecordRepository(pool),
        { mainExchange: "geo.v6.test.main", prefetch: 1 },
        quietLogger
      );
      await failing.start();
      await sendEnvelope(channel, "mock_queue", {
        messageId: "phase8-exhausted",
        eventType: "provider_job.created",
        aggregateType: "provider_job",
        aggregateId: "1",
        occurredAt: new Date().toISOString(),
        attempt: 1,
        payload: {
          providerJobId: "1",
          promptJobId: "1",
          provider: "mock",
          model: "mock-fast"
        }
      });
      const exhausted = await pollMessage(
        channel,
        deadLetterQueueName("mock_queue")
      );
      await failing.stop();
      assert.equal(exhausted.properties.messageId, "phase8-exhausted");
      channel.ack(exhausted);
      const attempts = await pool.query<{ attempt_number: number }>(
        `SELECT attempt_number FROM failure_records
         WHERE queue_name = 'mock_queue' AND message_id = 'phase8-exhausted'
         ORDER BY attempt_number`
      );
      assert.deepEqual(
        attempts.rows.map((row) => row.attempt_number),
        [1, 2, 3]
      );
    });

    it("does not create scores or reports and uses no real-provider jobs", async () => {
      const fixture = await seedPrompt(pool, "visibility", "anonymous");
      const planned = await new PromptExecutionService(pool).execute(
        promptPayload(fixture)
      );
      if (planned.outcome !== "enqueued") assert.fail("provider job not created");
      await new MockProviderService(pool).execute(
        providerPayload(fixture, planned.providerJobId)
      );
      for (const table of ["provider_scores", "reports"]) {
        const count = await pool.query<{ count: string }>(
          `SELECT count(*) FROM ${table}`
        );
        assert.equal(count.rows[0]?.count, "0", table);
      }
      const providers = await pool.query<{ provider: string }>(
        "SELECT DISTINCT provider FROM provider_jobs"
      );
      assert.deepEqual(providers.rows.map((row) => row.provider), ["mock"]);
    });
  }
);

const quietLogger = { info() {}, warn() {}, error() {} };

type Fixture = {
  promptJobId: string;
  llmRunId: string;
  itemId: string;
  runId: string;
  entityPathId: string;
  startingEntityPathId: string;
  promptType: PromptType;
  promptVersion: "v1" | "v1_light";
  expectedModel: "mock-fast" | "mock-standard" | "mock-quality";
  actorType: "anonymous" | "user";
  userId: string | null;
  workspaceId: string | null;
  anonymousSessionId: string | null;
};

async function seedPrompt(
  pool: pg.Pool,
  promptType: PromptType,
  ownership: "anonymous" | "user" | "claimed",
  suffix = crypto.randomUUID(),
  requestedModel: "mock-fast" | "mock-standard" | "mock-quality" | null = null
): Promise<Fixture> {
  const domain = await pool.query<{ id: string }>(
    `INSERT INTO domains (normalized_domain)
     VALUES ($1) RETURNING domain_id AS id`,
    [`phase8-${suffix}.example`]
  );
  const category = await pool.query<{ id: string }>(
    `INSERT INTO categories (category_name, normalized_name)
     VALUES ('Phase 8 Category', $1) RETURNING category_id AS id`,
    [`phase-8-${suffix}`]
  );
  const path = await pool.query<{ id: string }>(
    `INSERT INTO entity_paths (domain_id, category_id, path_type)
     VALUES ($1, $2, 'category') RETURNING entity_path_id AS id`,
    [domain.rows[0]!.id, category.rows[0]!.id]
  );
  let userId: string | null = null;
  let workspaceId: string | null = null;
  if (ownership !== "anonymous") {
    userId = (
      await pool.query<{ id: string }>(
        "INSERT INTO users (email) VALUES ($1) RETURNING user_id AS id",
        [`${suffix}@phase8.example`]
      )
    ).rows[0]!.id;
    workspaceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workspaces (workspace_name, created_by_user_id)
         VALUES ('Phase 8', $1) RETURNING workspace_id AS id`,
        [userId]
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [workspaceId, userId]
    );
  }
  let anonymousSessionId: string | null = null;
  if (ownership !== "user") {
    anonymousSessionId = (
      await pool.query<{ id: string }>(
      `INSERT INTO anonymous_sessions (
         token_hash, expires_at, claimed_by_user_id, claimed_workspace_id, claimed_at
       )
       VALUES ($1, now() + interval '1 day', $2, $3, $4)
       RETURNING anonymous_session_id AS id`,
      [
        `phase8-${suffix}`,
        userId,
        workspaceId,
        ownership === "claimed" ? new Date() : null
      ]
      )
    ).rows[0]!.id;
  }
  const resolvedModel =
    ownership === "anonymous"
      ? null
      : (requestedModel ?? "mock-standard");
  const runId = (
    await pool.query<{ id: string }>(
      `INSERT INTO analysis_runs (
         idempotency_key, anonymous_session_id, user_id, workspace_id,
         starting_entity_path_id, requested_provider, requested_model,
         status, request_payload, started_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', '{}'::jsonb, now())
       RETURNING analysis_run_id AS id`,
      [
        `phase8-run-${suffix}`,
        anonymousSessionId,
        userId,
        workspaceId,
        path.rows[0]!.id,
        ownership === "anonymous" ? null : "mock",
        resolvedModel
      ]
    )
  ).rows[0]!.id;
  const itemId = (
    await pool.query<{ id: string }>(
      `INSERT INTO analysis_run_items (
         idempotency_key, analysis_run_id, entity_path_id, item_ordinal,
         status, started_at
       )
       VALUES ($1, $2, $3, 0, 'processing', now())
       RETURNING analysis_run_item_id AS id`,
      [`phase8-item-${suffix}`, runId, path.rows[0]!.id]
    )
  ).rows[0]!.id;
  const llmRunId = (
    await pool.query<{ id: string }>(
      `INSERT INTO llm_runs (
         idempotency_key, analysis_run_item_id, run_key, status, started_at
       )
       VALUES ($1, $2, 'primary', 'processing', now())
       RETURNING llm_run_id AS id`,
      [`phase8-llm-${suffix}`, itemId]
    )
  ).rows[0]!.id;
  const promptJobId = (
    await pool.query<{ id: string }>(
      `INSERT INTO prompt_jobs (
         idempotency_key, llm_run_id, prompt_type, prompt_version,
         status, prompt_text
       )
       VALUES ($1, $2, $3, $4, 'pending', NULL)
       RETURNING prompt_job_id AS id`,
      [
        `phase8-prompt-${suffix}`,
        llmRunId,
        promptType,
        ownership === "anonymous" ? "v1_light" : "v1"
      ]
    )
  ).rows[0]!.id;
  return {
    promptJobId,
    llmRunId,
    itemId,
    runId,
    entityPathId: path.rows[0]!.id,
    startingEntityPathId: path.rows[0]!.id,
    promptType,
    promptVersion: ownership === "anonymous" ? "v1_light" : "v1",
    expectedModel: resolvedModel ?? "mock-fast",
    actorType: ownership === "anonymous" ? "anonymous" : "user",
    userId,
    workspaceId,
    anonymousSessionId
  };
}

function promptPayload(fixture: Fixture): PromptJobCreatedPayload {
  return {
    promptJobId: fixture.promptJobId,
    llmRunId: fixture.llmRunId,
    analysisRunItemId: fixture.itemId,
    analysisRunId: fixture.runId,
    entityPathId: fixture.entityPathId,
    startingEntityPathId: fixture.startingEntityPathId,
    promptType: fixture.promptType,
    promptVersion: fixture.promptVersion,
    actorType: fixture.actorType,
    userId: fixture.userId,
    workspaceId: fixture.workspaceId,
    anonymousSessionId: fixture.anonymousSessionId
  };
}

function promptEnvelope(fixture: Fixture) {
  return {
    messageId: `prompt_job.created:${fixture.promptJobId}`,
    eventType: "prompt_job.created",
    aggregateType: "prompt_job",
    aggregateId: fixture.promptJobId,
    occurredAt: new Date().toISOString(),
    attempt: 1,
    payload: promptPayload(fixture)
  };
}

function providerPayload(
  fixture: Fixture,
  providerJobId: string
): ProviderJobCreatedPayload {
  return {
    providerJobId,
    promptJobId: fixture.promptJobId,
    provider: "mock",
    model: fixture.expectedModel
  };
}

async function insertProviderJob(pool: pg.Pool, promptJobId: string) {
  return (
    await pool.query<{ provider_job_id: string }>(
      `INSERT INTO provider_jobs (
         idempotency_key, prompt_job_id, provider, model, status
       )
       VALUES ($1, $2, 'mock', 'mock-fast', 'queued')
       RETURNING provider_job_id`,
      [`manual-provider:${promptJobId}`, promptJobId]
    )
  ).rows[0]!;
}

async function promptState(pool: pg.Pool, promptJobId: string) {
  return (
    await pool.query<{ status: string; prompt_text: string | null }>(
      "SELECT status, prompt_text FROM prompt_jobs WHERE prompt_job_id = $1",
      [promptJobId]
    )
  ).rows[0]!;
}

async function providerJobs(pool: pg.Pool, promptJobId: string) {
  return (
    await pool.query<{
      provider_job_id: string;
      idempotency_key: string;
      provider: string;
      model: string;
      status: string;
    }>(
      "SELECT * FROM provider_jobs WHERE prompt_job_id = $1",
      [promptJobId]
    )
  ).rows;
}

async function providerOutbox(pool: pg.Pool, providerJobId: string) {
  return (
    await pool.query<{
      event_key: string;
      payload: ProviderJobCreatedPayload;
      headers: Record<string, unknown>;
    }>(
      `SELECT event_key, payload, headers FROM outbox_events
       WHERE event_type = 'provider_job.created' AND aggregate_id = $1`,
      [providerJobId]
    )
  ).rows[0]!;
}

async function providerResult(pool: pg.Pool, providerJobId: string) {
  return (
    await pool.query<{
      provider: string;
      status: string;
      model_version: string;
      parsed_response: Record<string, unknown>;
      latency_ms: number;
    }>("SELECT * FROM provider_results WHERE provider_job_id = $1", [
      providerJobId
    ])
  ).rows[0]!;
}

async function tokenUsage(pool: pg.Pool, providerJobId: string) {
  return (
    await pool.query<{
      usage_kind: string;
      input_tokens: string;
      output_tokens: string;
      cost_micros: string;
    }>("SELECT * FROM token_usage WHERE provider_job_id = $1", [providerJobId])
  ).rows;
}

async function evidenceCount(pool: pg.Pool, providerJobId: string) {
  return Number(
    (
      await pool.query<{ count: string }>(
        "SELECT count(*) FROM provider_results WHERE provider_job_id = $1",
        [providerJobId]
      )
    ).rows[0]!.count
  );
}

async function sendEnvelope(
  channel: Awaited<ReturnType<RabbitMqConnection["getConfirmChannel"]>>,
  queue: string,
  value: { messageId: string; [key: string]: unknown }
) {
  await new Promise<void>((resolve, reject) => {
    channel.publish(
      "geo.v6.test.main",
      queue,
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
  throw new Error("Timed out waiting for Phase 8 worker outcome");
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
