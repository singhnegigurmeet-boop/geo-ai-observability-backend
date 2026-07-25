import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import type { RequestHandler } from "express";
import pg from "pg";
import { AnalysisController } from "../../../src/modules/analysis/controllers/analysis.controller.js";
import { createAnalysisRouter } from "../../../src/modules/analysis/routes/analysis.router.js";
import { AnalysisService } from "../../../src/modules/analysis/services/analysis.service.js";
import { createApp } from "../../../src/app.js";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../../../src/common/database/migration-runner.js";
import { deadLetterQueueName } from "../../../src/common/messaging/queue-names.js";
import { RabbitMqConnection } from "../../../src/common/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../../src/common/messaging/rabbitmq.topology.js";
import { FailureRecordRepository } from "../../../src/modules/reliability/repositories/failure-record.repository.js";
import { ProviderScoreWorkerRuntime } from "../../../src/modules/scoring/runtime/provider-score-worker.runtime.js";
import { ProviderScoreService } from "../../../src/modules/scoring/services/provider-score.service.js";
import { ProviderScoreWorker } from "../../../src/modules/scoring/workers/provider-score-worker.js";
import type { ProviderResultCreatedPayload } from "../../../src/modules/scoring/messages/provider-score-worker.messages.js";
import type { PromptType } from "../../../src/common/types/database.types.js";

const enabled = process.env.RUN_SCORING_REPORTING_INTEGRATION_TESTS === "true";
const lightPrompts: PromptType[] = ["visibility", "competitor", "ranking"];
const richPrompts: PromptType[] = [
  ...lightPrompts,
  "price_range",
  "pros_cons"
];

describe(
    "Backend scoring and reporting integration",
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
      await channel.purgeQueue("scoring_queue");
      await channel.purgeQueue(deadLetterQueueName("scoring_queue"));
    });

    after(async () => {
      await rabbitMq?.close();
      await pool?.end();
    });

    it("creates immutable partial revisions and a final anonymous report", async () => {
      const fixture = await seedRun(pool, "anonymous", lightPrompts);
      const scoring = new ProviderScoreService(pool);

      const first = await scoring.process(fixture.results[0]!);
      assert.equal(first.outcome, "scored");
      assert.ok(first.reportId);
      assert.equal(await count(pool, "reports"), 1);

      const concurrentFinalScores = await Promise.all([
        scoring.process(fixture.results[1]!),
        scoring.process(fixture.results[2]!)
      ]);
      const completed = concurrentFinalScores.find(
        (result) => result.reportId !== null
      );
      assert.ok(completed?.reportId);
      assert.equal(await count(pool, "provider_scores"), 3);
      assert.equal(await count(pool, "reports"), 3);

      const report = await reportFor(pool, fixture.analysisRunId);
      assert.equal(report.report_data.reportType, "multi_provider_report");
      assert.equal(report.report_data.breakdown.length, 3);
      assert.equal(report.report_data.providerResults[0]?.model, "mock-fast");
      assert.equal(report.run_status, "completed");
      assert.ok(report.completed_at);
      const executionStates = await pool.query<{
        item_status: string;
        llm_status: string;
      }>(
        `
          SELECT item.status AS item_status, llm.status AS llm_status
          FROM analysis_run_items AS item
          JOIN llm_runs AS llm
            ON llm.analysis_run_item_id = item.analysis_run_item_id
          WHERE item.analysis_run_id = $1
        `,
        [fixture.analysisRunId]
      );
      assert.deepEqual(executionStates.rows, [
        { item_status: "completed", llm_status: "completed" }
      ]);

      const replay = await scoring.process(fixture.results.at(-1)!);
      assert.equal(replay.outcome, "noop");
      assert.ok(replay.reportId);
      assert.equal(await count(pool, "provider_scores"), 3);
      assert.equal(await count(pool, "reports"), 3);
    });

    it("revises logged-in and claimed reports through all five scores", async () => {
      for (const actor of ["user", "claimed"] as const) {
        const fixture = await seedRun(pool, actor, richPrompts);
        const scoring = new ProviderScoreService(pool);
        for (const result of fixture.results.slice(0, 4)) {
          assert.ok((await scoring.process(result)).reportId);
        }
        assert.equal(
          Number(
            (
              await pool.query<{ count: string }>(
                "SELECT count(*) FROM reports WHERE analysis_run_id = $1",
                [fixture.analysisRunId]
              )
            ).rows[0]!.count
          ),
          4
        );
        const completed = await scoring.process(fixture.results[4]!);
        assert.ok(completed.reportId);
        const report = await reportFor(pool, fixture.analysisRunId);
        assert.equal(report.report_data.breakdown.length, 5);
        assert.equal(
          report.report_data.providerResults[0]?.model,
          "mock-standard"
        );
        if (actor === "claimed") {
          assert.ok(fixture.anonymousSessionId);
        }
      }
    });

    it("uses backend interpretation instead of provider-supplied score values", async () => {
      const fixture = await seedRun(pool, "anonymous", ["visibility"], {
        providerScore: 100,
        confidence: 0.5
      });
      await new ProviderScoreService(pool).process(fixture.results[0]!);
      const score = await pool.query<{
        score: string;
        score_components: Record<string, unknown>;
      }>("SELECT score, score_components FROM provider_scores");
      assert.equal(score.rows[0]?.score, "64.0000");
      assert.equal(
        score.rows[0]?.score_components.scoringVersion,
        "backend-v1"
      );
    });

    it("serves reports only to the owning anonymous session or workspace", async () => {
      const anonymous = await seedRun(pool, "anonymous", lightPrompts);
      const user = await seedRun(pool, "user", richPrompts);
      for (const result of [...anonymous.results, ...user.results]) {
        await new ProviderScoreService(pool).process(result);
      }

      const ownership: RequestHandler = (request, _response, next) => {
        const actor = request.get("x-test-owner");
        if (actor === "anonymous") {
          request.ownershipContext = {
            actorType: "anonymous",
            anonymousSessionId: anonymous.anonymousSessionId!,
            userId: null,
            workspaceId: null
          };
        } else if (actor === "user") {
          request.ownershipContext = {
            actorType: "user",
            anonymousSessionId: null,
            userId: user.userId!,
            workspaceId: user.workspaceId!,
            workspaceRole: "owner"
          };
        } else {
          request.ownershipContext = {
            actorType: "anonymous",
            anonymousSessionId: "999999",
            userId: null,
            workspaceId: null
          };
        }
        next();
      };
      const service = new AnalysisService(pool);
      const server = await listen(
        createApp({
          analysisRouter: createAnalysisRouter(
            new AnalysisController(service),
            ownership
          )
        })
      );
      try {
        const anonymousResponse = await fetch(
          `${server.url}/v1/analysis/runs/${anonymous.analysisRunId}/report`,
          { headers: { "x-test-owner": "anonymous" } }
        );
        assert.equal(anonymousResponse.status, 200);
        const body = (await anonymousResponse.json()) as {
          analysisRunId: string;
          report: { reportType: string };
        };
        assert.equal(body.analysisRunId, anonymous.analysisRunId);
        assert.equal(body.report.reportType, "multi_provider_report");

        const crossOwner = await fetch(
          `${server.url}/v1/analysis/runs/${user.analysisRunId}/report`,
          { headers: { "x-test-owner": "anonymous" } }
        );
        assert.equal(crossOwner.status, 404);
        const userResponse = await fetch(
          `${server.url}/v1/analysis/runs/${user.analysisRunId}/report`,
          { headers: { "x-test-owner": "user" } }
        );
        assert.equal(userResponse.status, 200);
      } finally {
        await server.close();
      }
    });

    it("consumes live result events and dead-letters malformed or exhausted work", async () => {
      const fixture = await seedRun(pool, "anonymous", ["visibility"]);
      const channel = await rabbitMq.getConfirmChannel();
      const runtime = new ProviderScoreWorkerRuntime(
        channel,
        new ProviderScoreWorker(new ProviderScoreService(pool)),
        new FailureRecordRepository(pool),
        {
          mainExchange: "geo.v6.test.main",
          prefetch: 1
        },
        { info() {}, warn() {}, error() {} }
      );
      await runtime.start();
      try {
        await sendEnvelope(channel, "scoring_queue", {
          messageId: "reporting-valid",
          eventType: "provider_result.created",
          aggregateType: "provider_result",
          aggregateId: fixture.results[0]!.providerResultId,
          occurredAt: new Date().toISOString(),
          attempt: 1,
          payload: fixture.results[0]!
        });
        await pollUntil(async () => (await count(pool, "reports")) === 1);

        await sendEnvelope(channel, "scoring_queue", {
          messageId: "reporting-malformed",
          bad: true
        });
        await sendEnvelope(channel, "scoring_queue", {
          messageId: "reporting-exhausted",
          eventType: "provider_result.created",
          aggregateType: "provider_result",
          aggregateId: "999999",
          occurredAt: new Date().toISOString(),
          attempt: 1,
          payload: {
            providerResultId: "999999"
          }
        });
        await pollUntil(async () => {
          const records = await pool.query<{ message_id: string }>(
            `
              SELECT DISTINCT message_id
              FROM failure_records
              WHERE queue_name = 'scoring_queue'
            `
          );
          const ids = new Set(records.rows.map((row) => row.message_id));
          return ids.has("reporting-malformed") && ids.has("reporting-exhausted");
        });
        const dlq = deadLetterQueueName("scoring_queue");
        const first = await pollMessage(channel, dlq);
        channel.ack(first);
        const second = await pollMessage(channel, dlq);
        channel.ack(second);
        const attempts = await pool.query<{ attempt_number: number }>(
          `
            SELECT attempt_number
            FROM failure_records
            WHERE queue_name = 'scoring_queue'
              AND message_id = 'reporting-exhausted'
            ORDER BY attempt_number
          `
        );
        assert.deepEqual(
          attempts.rows.map((row) => row.attempt_number),
          [1, 2, 3]
        );
      } finally {
        await runtime.stop();
      }
      assert.equal(await count(pool, "provider_scores"), 1);
      assert.equal(await count(pool, "reports"), 1);
    });

    it("creates one report notification per immutable report revision", async () => {
      const fixture = await seedRun(pool, "user", richPrompts);
      for (const result of fixture.results) {
        await new ProviderScoreService(pool).process(result);
      }
      assert.equal(await count(pool, "budget_policies"), 0);
      const notifications = await pool.query<{
        type: string;
        is_admin_notification: boolean;
      }>(
        `
          SELECT payload->>'type' AS type, is_admin_notification
          FROM notifications
        `
      );
      assert.equal(notifications.rows.length, 5);
      assert.ok(
        notifications.rows.every(
          (notification) =>
            notification.type === "report_ready" &&
            notification.is_admin_notification === false
        )
      );
      assert.equal(await count(pool, "scheduler_jobs"), 0);
      const providers = await pool.query<{ provider: string }>(
        "SELECT DISTINCT provider FROM provider_jobs"
      );
      assert.deepEqual(providers.rows, [{ provider: "mock" }]);
    });
  }
);

type Actor = "anonymous" | "user" | "claimed";

async function seedRun(
  pool: pg.Pool,
  actor: Actor,
  promptTypes: PromptType[],
  evidence: { providerScore?: number; confidence?: number } = {}
) {
  const unique = crypto.randomUUID();
  let userId: string | null = null;
  let workspaceId: string | null = null;
  let anonymousSessionId: string | null = null;

  if (actor !== "anonymous") {
    userId = (
      await pool.query<{ user_id: string }>(
        "INSERT INTO users (email) VALUES ($1) RETURNING user_id",
        [`reporting-${unique}@example.com`]
      )
    ).rows[0]!.user_id;
    workspaceId = (
      await pool.query<{ workspace_id: string }>(
        `
          INSERT INTO workspaces (workspace_name, created_by_user_id)
          VALUES ($1, $2)
          RETURNING workspace_id
        `,
        [`Reporting ${unique}`, userId]
      )
    ).rows[0]!.workspace_id;
    await pool.query(
      `
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES ($1, $2, 'owner')
      `,
      [workspaceId, userId]
    );
  }
  if (actor !== "user") {
    anonymousSessionId = (
      await pool.query<{ anonymous_session_id: string }>(
        `
          INSERT INTO anonymous_sessions (
            token_hash, expires_at, claimed_by_user_id,
            claimed_workspace_id, claimed_at
          )
          VALUES (
            $1, now() + interval '1 day', $2, $3,
            CASE WHEN $2::bigint IS NULL THEN NULL ELSE now() END
          )
          RETURNING anonymous_session_id
        `,
        [`reporting-token-${unique}`, userId, workspaceId]
      )
    ).rows[0]!.anonymous_session_id;
  }
  const domainId = (
    await pool.query<{ domain_id: string }>(
      `
        INSERT INTO domains (normalized_domain)
        VALUES ($1)
        RETURNING domain_id
      `,
      [`reporting-${unique}.example`]
    )
  ).rows[0]!.domain_id;
  const pathId = (
    await pool.query<{ entity_path_id: string }>(
      `
        INSERT INTO entity_paths (domain_id, path_type)
        VALUES ($1, 'domain')
        RETURNING entity_path_id
      `,
      [domainId]
    )
  ).rows[0]!.entity_path_id;
  const analysisRunId = (
    await pool.query<{ analysis_run_id: string }>(
      `
        INSERT INTO analysis_runs (
          idempotency_key, anonymous_session_id, user_id, workspace_id,
          starting_entity_path_id, status, request_payload, started_at
        )
        VALUES (
          $1, $2, $3, $4, $5, 'processing', '{}'::jsonb, now()
        )
        RETURNING analysis_run_id
      `,
      [
        `reporting-run:${unique}`,
        anonymousSessionId,
        userId,
        workspaceId,
        pathId
      ]
    )
  ).rows[0]!.analysis_run_id;
  await pool.query(
    `INSERT INTO analysis_run_provider_models
       (analysis_run_id, provider, model, ordinal)
     VALUES ($1, 'mock', $2, 0)`,
    [analysisRunId, actor === "anonymous" ? "mock-fast" : "mock-standard"]
  );
  const itemId = (
    await pool.query<{ analysis_run_item_id: string }>(
      `
        INSERT INTO analysis_run_items (
          idempotency_key, analysis_run_id, entity_path_id,
          item_ordinal, status, started_at, completed_at
        )
        VALUES ($1, $2, $3, 0, 'completed', now(), now())
        RETURNING analysis_run_item_id
      `,
      [`reporting-item:${unique}`, analysisRunId, pathId]
    )
  ).rows[0]!.analysis_run_item_id;
  const llmRunId = (
    await pool.query<{ llm_run_id: string }>(
      `
        INSERT INTO llm_runs (
          idempotency_key, analysis_run_item_id, status,
          started_at, completed_at
        )
        VALUES ($1, $2, 'completed', now(), now())
        RETURNING llm_run_id
      `,
      [`reporting-llm:${unique}`, itemId]
    )
  ).rows[0]!.llm_run_id;

  const results: ProviderResultCreatedPayload[] = [];
  for (const promptType of promptTypes) {
    const promptJobId = (
      await pool.query<{ prompt_job_id: string }>(
        `
          INSERT INTO prompt_jobs (
            idempotency_key, llm_run_id, prompt_type, prompt_version,
            status, prompt_text, started_at, completed_at
          )
          VALUES ($1, $2, $3, $4, 'succeeded', $5, now(), now())
          RETURNING prompt_job_id
        `,
        [
          `reporting-prompt:${unique}:${promptType}`,
          llmRunId,
          promptType,
          actor === "anonymous" ? "v1_light" : "v1",
          `Canonical ${promptType} prompt`
        ]
      )
    ).rows[0]!.prompt_job_id;
    const model = actor === "anonymous" ? "mock-fast" : "mock-standard";
    const providerJobId = (
      await pool.query<{ provider_job_id: string }>(
        `
          INSERT INTO provider_jobs (
            idempotency_key, prompt_job_id, provider, model, status,
            started_at, completed_at
          )
          VALUES ($1, $2, 'mock', $3, 'succeeded', now(), now())
          RETURNING provider_job_id
        `,
        [`reporting-provider:${unique}:${promptType}`, promptJobId, model]
      )
    ).rows[0]!.provider_job_id;
    const parsedResponse = {
      score: evidence.providerScore ?? 0,
      evidence: [
        {
          claim: `Mock ${promptType} evidence`,
          source: "mock-provider",
          confidence: evidence.confidence ?? 0.75
        }
      ],
      summary: `Mock ${promptType} summary`
    };
    const providerResultId = (
      await pool.query<{ provider_result_id: string }>(
        `
          INSERT INTO provider_results (
            idempotency_key, provider_job_id, provider, status,
            provider_request_id, model_version, raw_response,
            parsed_response, validation_errors, finish_reason,
            latency_ms, received_at
          )
          VALUES (
            $1, $2, 'mock', 'valid', $3, $4, $5, $6,
            '[]'::jsonb, 'mock_complete', 0, now()
          )
          RETURNING provider_result_id
        `,
        [
          `reporting-result:${unique}:${promptType}`,
          providerJobId,
          `reporting-request:${unique}:${promptType}`,
          model,
          JSON.stringify(parsedResponse),
          parsedResponse
        ]
      )
    ).rows[0]!.provider_result_id;
    await pool.query(
      `
        INSERT INTO token_usage (
          idempotency_key, provider_job_id, usage_kind,
          input_tokens, output_tokens, cost_micros
        )
        VALUES ($1, $2, 'actual', 10, 5, 0)
      `,
      [`reporting-usage:${unique}:${promptType}`, providerJobId]
    );
    results.push({
      providerResultId
    });
  }
  return {
    analysisRunId,
    anonymousSessionId,
    userId,
    workspaceId,
    results
  };
}

async function count(pool: pg.Pool, table: string) {
  if (
    ![
      "provider_scores",
      "reports",
      "budget_policies",
      "notifications",
      "scheduler_jobs"
    ].includes(table)
  ) {
    throw new Error("Unsupported count table");
  }
  return Number(
    (await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`))
      .rows[0]!.count
  );
}

async function reportFor(pool: pg.Pool, analysisRunId: string) {
  return (
    await pool.query<{
      report_data: {
        reportType: string;
        breakdown: unknown[];
        providerResults: Array<{ model: string }>;
      };
      run_status: string;
      completed_at: Date | null;
    }>(
      `
        SELECT report.report_data, run.status AS run_status, run.completed_at
        FROM reports AS report
        JOIN analysis_runs AS run
          ON run.analysis_run_id = report.analysis_run_id
        WHERE report.analysis_run_id = $1
        ORDER BY report.revision DESC
        LIMIT 1
      `,
      [analysisRunId]
    )
  ).rows[0]!;
}

async function listen(app: ReturnType<typeof createApp>) {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
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
  throw new Error("Timed out waiting for scoring worker outcome");
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
