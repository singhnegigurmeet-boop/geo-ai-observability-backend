import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import type { RequestHandler } from "express";
import pg from "pg";
import { AnalysisController } from "../../../src/modules/analysis/controllers/analysis.controller.js";
import { createAnalysisRouter } from "../../../src/modules/analysis/routes/analysis.router.js";
import { AnalysisService } from "../../../src/modules/analysis/services/analysis.service.js";
import { createApp } from "../../../src/app.js";
import { BudgetRepository } from "../../../src/modules/budgets/repositories/budget.repository.js";
import { TokenEstimatorService } from "../../../src/modules/budgets/services/token-estimator.service.js";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../../../src/common/database/migration-runner.js";
import { deadLetterQueueName } from "../../../src/common/messaging/queue-names.js";
import { RabbitMqConnection } from "../../../src/common/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../../src/common/messaging/rabbitmq.topology.js";
import { MockProviderService } from "../../../src/modules/providers/services/mock-provider.service.js";
import { MockProviderWorker } from "../../../src/modules/providers/workers/mock-provider-worker.js";
import type { ProviderJobCreatedPayload } from "../../../src/modules/providers/messages/provider-worker.messages.js";
import { FailureRecordRepository } from "../../../src/modules/reliability/repositories/failure-record.repository.js";
import { MockProviderWorkerRuntime } from "../../../src/modules/providers/runtime/mock-provider-worker.runtime.js";
import { ProviderScoreService } from "../../../src/modules/scoring/services/provider-score.service.js";
import type {
  ProviderResultCreatedPayload
} from "../../../src/modules/scoring/messages/provider-score-worker.messages.js";
import type { PromptType } from "../../../src/common/types/database.types.js";
import { promptTypePolicy } from "../../../src/modules/prompts/policies/prompt-policy.registry.js";
import { providerModelProfile } from "../../../src/modules/providers/registry/provider-model.registry.js";

const enabled = process.env.RUN_BUDGET_CONCURRENCY_INTEGRATION_TESTS === "true";
const lightPrompts: PromptType[] = ["visibility", "competitor", "ranking"];

describe(
    "Provider budget and concurrency integration",
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
      await truncatePublicTables(pool);
      const channel = await rabbitMq.getConfirmChannel();
      for (const queue of ["mock_queue", "scoring_queue"] as const) {
        await channel.purgeQueue(queue);
        await channel.purgeQueue(deadLetterQueueName(queue));
      }
    });

    after(async () => {
      await rabbitMq?.close();
      await pool?.end();
    });

    it("reserves estimated usage before execution and reconciles accounting to actual", async () => {
      const fixture = await seedRun(pool, "anonymous", ["visibility"]);
      const job = fixture.jobs[0]!;
      await createPolicy(pool, {
        scope: "platform_default",
        workspaceId: null,
        mode: "hard",
        tokenLimit: 10_000
      });
      const outcome = await new MockProviderService(pool).execute(job.payload);
      assert.equal(outcome.outcome, "completed");
      assert.equal(await count(pool, "provider_results"), 1);

      const usage = await pool.query<{
        usage_kind: "estimated" | "actual";
        total_tokens: string;
        cost_micros: string;
      }>(
        `
          SELECT usage_kind, total_tokens, cost_micros
          FROM token_usage
          WHERE provider_job_id = $1
          ORDER BY usage_kind
        `,
        [job.providerJobId]
      );
      assert.deepEqual(
        usage.rows.map((row) => row.usage_kind).sort(),
        ["actual", "estimated"]
      );
      assert.ok(
        usage.rows.every(
          (row) =>
            Number.isInteger(Number(row.total_tokens)) &&
            Number.isInteger(Number(row.cost_micros))
        )
      );
      const actual = usage.rows.find((row) => row.usage_kind === "actual")!;
      const estimated = usage.rows.find(
        (row) => row.usage_kind === "estimated"
      )!;
      assert.ok(
        Number(estimated.total_tokens) >= Number(actual.total_tokens),
        "deterministic mock reservation must cover deterministic actual usage"
      );
      assert.ok(
        Number(estimated.cost_micros) >= Number(actual.cost_micros),
        "deterministic mock cost reservation must cover actual mock cost"
      );
      const consumption = await new BudgetRepository(pool).consumption({
        budgetPolicyId: "1",
        budgetScope: "platform_default",
        workspaceId: null,
        userId: null,
        anonymousSessionId: null,
        analysisRunId: null,
        provider: "mock",
        model: null,
        limitMode: "hard",
        windowSeconds: 3600,
        tokenLimit: "10000",
        costLimitMicros: null,
        currencyCode: "USD"
      });
      assert.equal(consumption.totalTokens, actual.total_tokens);
      assert.equal(consumption.costMicros, actual.cost_micros);
    });

    it("hard-pauses before evidence and redelivery is an idempotent business no-op", async () => {
      const fixture = await seedRun(pool, "anonymous", ["ranking"]);
      const job = fixture.jobs[0]!;
      const estimate = estimateFor(job);
      const policyId = await createPolicy(pool, {
        scope: "platform_default",
        workspaceId: null,
        mode: "hard",
        tokenLimit: estimate.totalTokens - 1
      });

      assert.deepEqual(await new MockProviderService(pool).execute(job.payload), {
        outcome: "paused_budget",
        providerResultId: null,
        budgetPolicyId: policyId
      });
      assert.equal(await count(pool, "provider_results"), 0);
      assert.equal(await count(pool, "token_usage"), 0);
      assert.equal(await runStatus(pool, fixture.analysisRunId), "paused_budget");
      assert.equal(await providerStatus(pool, job.providerJobId), "paused_budget");
      assert.deepEqual(await new MockProviderService(pool).execute(job.payload), {
        outcome: "noop",
        providerResultId: null
      });
      assert.equal(await count(pool, "failure_records"), 0);
    });

    it("soft mode allows exactly one crossing prompt and pauses later work", async () => {
      const fixture = await seedRun(pool, "anonymous", [
        "visibility",
        "competitor",
        "ranking"
      ]);
      const first = fixture.jobs[0]!;
      const actualFirstTokens =
        Math.max(1, Math.ceil(first.promptText.length / 4)) + 32;
      await createPolicy(pool, {
        scope: "platform_default",
        workspaceId: null,
        mode: "soft",
        tokenLimit: actualFirstTokens - 1
      });

      assert.equal(
        (await new MockProviderService(pool).execute(first.payload)).outcome,
        "completed"
      );
      assert.equal(
        (
          await new MockProviderService(pool).execute(
            fixture.jobs[1]!.payload
          )
        ).outcome,
        "paused_budget"
      );
      assert.equal(
        (
          await new MockProviderService(pool).execute(
            fixture.jobs[2]!.payload
          )
        ).outcome,
        "noop"
      );
      assert.equal(await count(pool, "provider_results"), 1);
      assert.deepEqual(
        await providerStatuses(pool, fixture.analysisRunId),
        ["paused_budget", "paused_budget", "succeeded"]
      );
    });

    it("serializes concurrent hard checks for every frozen budget scope", async () => {
      const cases = [
        { scope: "platform_default", actor: "anonymous" },
        { scope: "workspace", actor: "user" },
        { scope: "user", actor: "user" },
        { scope: "anonymous_session", actor: "anonymous" },
        { scope: "analysis_run", actor: "anonymous" }
      ] as const;
      for (const [index, testCase] of cases.entries()) {
        if (index > 0) await truncatePublicTables(pool);
        const fixture = await seedRun(pool, testCase.actor, [
          "visibility",
          "ranking",
          "competitor"
        ]);
        const limit = Math.max(
          ...fixture.jobs.map((job) => estimateFor(job).totalTokens)
        );
        await createPolicy(pool, {
          scope: testCase.scope,
          workspaceId:
            testCase.scope === "workspace" ? fixture.workspaceId : null,
          userId: testCase.scope === "user" ? fixture.userId : null,
          anonymousSessionId:
            testCase.scope === "anonymous_session"
              ? fixture.anonymousSessionId
              : null,
          analysisRunId:
            testCase.scope === "analysis_run"
              ? fixture.analysisRunId
              : null,
          mode: "hard",
          tokenLimit: limit
        });
        const outcomes = await Promise.all(
          fixture.jobs.map((job) =>
            new MockProviderService(pool).execute(job.payload)
          )
        );
        assert.equal(
          outcomes.filter((outcome) => outcome.outcome === "completed")
            .length,
          1,
          testCase.scope
        );
        assert.equal(
          outcomes.filter(
            (outcome) => outcome.outcome === "paused_budget"
          ).length,
          1,
          testCase.scope
        );
        assert.equal(
          outcomes.filter((outcome) => outcome.outcome === "noop").length,
          1,
          testCase.scope
        );
        assert.equal(await count(pool, "provider_results"), 1);
        assert.equal(
          Number(
            (
              await pool.query<{ count: string }>(
                `
                  SELECT count(DISTINCT provider_job_id)
                  FROM token_usage
                  WHERE usage_kind = 'estimated'
                `
              )
            ).rows[0]!.count
          ),
          1,
          testCase.scope
        );
      }
    });

    it("does not leak workspace policies into anonymous work", async () => {
      const anonymous = await seedRun(pool, "anonymous", ["visibility"]);
      const user = await seedRun(pool, "user", ["visibility"]);
      const claimed = await seedRun(pool, "claimed", ["visibility"], {
        userId: user.userId!,
        workspaceId: user.workspaceId!
      });
      await createPolicy(pool, {
        scope: "workspace",
        workspaceId: user.workspaceId,
        mode: "hard",
        tokenLimit: 1
      });
      await pool.query(
        `
          INSERT INTO budget_policies (
            budget_scope, provider, limit_mode, window_seconds, token_limit
          )
          VALUES ('platform_default', 'openai', 'hard', 3600, 1)
        `
      );

      assert.equal(
        (
          await new MockProviderService(pool).execute(
            anonymous.jobs[0]!.payload
          )
        ).outcome,
        "completed"
      );
      assert.equal(
        (
          await new MockProviderService(pool).execute(user.jobs[0]!.payload)
        ).outcome,
        "paused_budget"
      );
      assert.equal(
        (
          await new MockProviderService(pool).execute(
            claimed.jobs[0]!.payload
          )
        ).outcome,
        "paused_budget"
      );
      assert.ok(claimed.anonymousSessionId);
      assert.equal(await runStatus(pool, anonymous.analysisRunId), "processing");
      assert.equal(await runStatus(pool, user.analysisRunId), "paused_budget");
      assert.equal(
        await runStatus(pool, claimed.analysisRunId),
        "paused_budget"
      );

      const ownership: RequestHandler = (request, _response, next) => {
        request.ownershipContext = {
          actorType: "user",
          anonymousSessionId:
            request.get("x-test-owner") === "claimed"
              ? claimed.anonymousSessionId
              : null,
          userId: user.userId!,
          workspaceId:
            request.get("x-test-owner") === "wrong-workspace"
              ? "999999"
              : user.workspaceId!,
          workspaceRole: "owner"
        };
        next();
      };
      const server = await listen(
        createApp({
          analysisRouter: createAnalysisRouter(
            new AnalysisController(new AnalysisService(pool)),
            ownership
          )
        })
      );
      try {
        const userStatus = await fetch(
          `${server.url}/v1/analysis/runs/${user.analysisRunId}`,
          { headers: { "x-test-owner": "user" } }
        );
        assert.equal(userStatus.status, 200);
        assert.equal(
          ((await userStatus.json()) as { status: string }).status,
          "paused_budget"
        );
        const claimedStatus = await fetch(
          `${server.url}/v1/analysis/runs/${claimed.analysisRunId}`,
          { headers: { "x-test-owner": "claimed" } }
        );
        assert.equal(claimedStatus.status, 200);
        const wrongWorkspace = await fetch(
          `${server.url}/v1/analysis/runs/${user.analysisRunId}`,
          { headers: { "x-test-owner": "wrong-workspace" } }
        );
        assert.equal(wrongWorkspace.status, 404);
      } finally {
        await server.close();
      }
    });

    it("selects the exact frozen scope set for anonymous, user, and claimed ownership", async () => {
      const anonymous = await seedRun(pool, "anonymous", ["visibility"]);
      const user = await seedRun(pool, "user", ["visibility"]);
      const claimed = await seedRun(pool, "claimed", ["visibility"]);
      await createPolicy(pool, {
        scope: "platform_default",
        workspaceId: null,
        mode: "hard",
        tokenLimit: 100_000
      });
      await createPolicy(pool, {
        scope: "anonymous_session",
        workspaceId: null,
        anonymousSessionId: anonymous.anonymousSessionId,
        mode: "hard",
        tokenLimit: 100_000
      });
      await createPolicy(pool, {
        scope: "analysis_run",
        workspaceId: null,
        analysisRunId: anonymous.analysisRunId,
        mode: "hard",
        tokenLimit: 100_000
      });
      for (const fixture of [user, claimed]) {
        await createPolicy(pool, {
          scope: "workspace",
          workspaceId: fixture.workspaceId,
          mode: "hard",
          tokenLimit: 100_000
        });
        await createPolicy(pool, {
          scope: "user",
          workspaceId: null,
          userId: fixture.userId,
          mode: "hard",
          tokenLimit: 100_000
        });
        await createPolicy(pool, {
          scope: "analysis_run",
          workspaceId: null,
          analysisRunId: fixture.analysisRunId,
          mode: "hard",
          tokenLimit: 100_000
        });
      }
      await createPolicy(pool, {
        scope: "anonymous_session",
        workspaceId: null,
        anonymousSessionId: claimed.anonymousSessionId,
        mode: "hard",
        tokenLimit: 1
      });

      assert.deepEqual(await applicableScopes(pool, anonymous), [
        "platform_default",
        "anonymous_session",
        "analysis_run"
      ]);
      assert.deepEqual(await applicableScopes(pool, user), [
        "platform_default",
        "workspace",
        "user",
        "analysis_run"
      ]);
      assert.deepEqual(await applicableScopes(pool, claimed), [
        "platform_default",
        "workspace",
        "user",
        "analysis_run"
      ]);
      assert.equal(
        (
          await new MockProviderService(pool).execute(
            claimed.jobs[0]!.payload
          )
        ).outcome,
        "completed",
        "claimed work must not apply its preserved anonymous-session policy"
      );
    });

    it("applies provider-wide and exact-model policies without mixing provider and model", async () => {
      const allowed = await seedRun(pool, "anonymous", ["visibility"]);
      await createPolicy(pool, {
        scope: "analysis_run",
        workspaceId: null,
        analysisRunId: allowed.analysisRunId,
        model: "mock-standard",
        mode: "hard",
        tokenLimit: 1
      });
      assert.equal(
        (
          await new MockProviderService(pool).execute(
            allowed.jobs[0]!.payload
          )
        ).outcome,
        "completed"
      );

      const blocked = await seedRun(pool, "anonymous", ["visibility"]);
      await createPolicy(pool, {
        scope: "analysis_run",
        workspaceId: null,
        analysisRunId: blocked.analysisRunId,
        model: "mock-fast",
        mode: "hard",
        tokenLimit: 1
      });
      assert.equal(
        (
          await new MockProviderService(pool).execute(
            blocked.jobs[0]!.payload
          )
        ).outcome,
        "paused_budget"
      );
    });

    it("acknowledges a live budget pause without retry, failure record, or DLQ", async () => {
      const fixture = await seedRun(pool, "anonymous", ["visibility"]);
      const job = fixture.jobs[0]!;
      await createPolicy(pool, {
        scope: "platform_default",
        workspaceId: null,
        mode: "hard",
        tokenLimit: 1
      });
      const channel = await rabbitMq.getConfirmChannel();
      const runtime = new MockProviderWorkerRuntime(
        channel,
        new MockProviderWorker(new MockProviderService(pool)),
        new FailureRecordRepository(pool),
        { mainExchange: "geo.v6.test.main", prefetch: 1 },
        { info() {}, warn() {}, error() {} }
      );
      await runtime.start();
      try {
        await sendEnvelope(channel, "mock_queue", {
          messageId: "budget-budget-pause",
          eventType: "provider_job.created",
          aggregateType: "provider_job",
          aggregateId: job.providerJobId,
          occurredAt: new Date().toISOString(),
          attempt: 1,
          payload: job.payload
        });
        await pollUntil(
          async () =>
            (await runStatus(pool, fixture.analysisRunId)) === "paused_budget"
        );
        assert.equal(await count(pool, "failure_records"), 0);
        assert.equal(await channel.get("mock_queue", { noAck: true }), false);
        assert.equal(
          await channel.get(deadLetterQueueName("mock_queue"), {
            noAck: true
          }),
          false
        );
      } finally {
        await runtime.stop();
      }

      const ownership: RequestHandler = (request, _response, next) => {
        request.ownershipContext =
          request.get("x-test-owner") === "correct"
            ? {
                actorType: "anonymous",
                anonymousSessionId: fixture.anonymousSessionId!,
                userId: null,
                workspaceId: null
              }
            : {
                actorType: "anonymous",
                anonymousSessionId: "999999",
                userId: null,
                workspaceId: null
              };
        next();
      };
      const server = await listen(
        createApp({
          analysisRouter: createAnalysisRouter(
            new AnalysisController(new AnalysisService(pool)),
            ownership
          )
        })
      );
      try {
        const allowed = await fetch(
          `${server.url}/v1/analysis/runs/${fixture.analysisRunId}`,
          { headers: { "x-test-owner": "correct" } }
        );
        assert.equal(allowed.status, 200);
        const body = (await allowed.json()) as {
          status: string;
          errorMessage: string | null;
        };
        assert.equal(body.status, "paused_budget");
        assert.equal(body.errorMessage, null);
        const denied = await fetch(
          `${server.url}/v1/analysis/runs/${fixture.analysisRunId}`,
          { headers: { "x-test-owner": "wrong" } }
        );
        assert.equal(denied.status, 404);
      } finally {
        await server.close();
      }
    });

    it("preserves scoring and reporting when budgets allow", async () => {
      const fixture = await seedRun(pool, "anonymous", lightPrompts);
      await createPolicy(pool, {
        scope: "platform_default",
        workspaceId: null,
        mode: "hard",
        tokenLimit: 100_000
      });
      const resultPayloads: ProviderResultCreatedPayload[] = [];
      for (const job of fixture.jobs) {
        const outcome = await new MockProviderService(pool).execute(job.payload);
        assert.equal(outcome.outcome, "completed");
        if (outcome.outcome !== "completed") continue;
        resultPayloads.push({
          providerResultId: outcome.providerResultId
        });
      }
      for (const result of [resultPayloads[0]!, resultPayloads[2]!]) {
        await new ProviderScoreService(pool).process(result);
      }
      assert.equal(await count(pool, "provider_scores"), 2);
      assert.equal(await count(pool, "reports"), 2);
      assert.equal(await runStatus(pool, fixture.analysisRunId), "completed");
    });
  }
);

type Actor = "anonymous" | "user" | "claimed";

type SeedOptions = {
  userId?: string;
  workspaceId?: string;
};

async function seedRun(
  pool: pg.Pool,
  actor: Actor,
  promptTypes: PromptType[],
  options: SeedOptions = {}
) {
  const unique = crypto.randomUUID();
  let userId = options.userId ?? null;
  let workspaceId = options.workspaceId ?? null;
  let anonymousSessionId: string | null = null;

  if (actor !== "anonymous" && (!userId || !workspaceId)) {
    userId = (
      await pool.query<{ user_id: string }>(
        "INSERT INTO users (email) VALUES ($1) RETURNING user_id",
        [`budget-${unique}@example.com`]
      )
    ).rows[0]!.user_id;
    workspaceId = (
      await pool.query<{ workspace_id: string }>(
        `
          INSERT INTO workspaces (workspace_name, created_by_user_id)
          VALUES ($1, $2)
          RETURNING workspace_id
        `,
        [`Budget ${unique}`, userId]
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
        [`budget-token-${unique}`, userId, workspaceId]
      )
    ).rows[0]!.anonymous_session_id;
  }
  const domainId = (
    await pool.query<{ domain_id: string }>(
      "INSERT INTO domains (normalized_domain) VALUES ($1) RETURNING domain_id",
      [`budget-${unique}.example`]
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
          starting_entity_path_id, category_selection_mode, prompt_depth,
          prompt_policy_version, status, request_payload, started_at
        )
        VALUES (
          $1, $2, $3, $4, $5, 'all', $6, 'geo-prompt-policy-v1',
          'processing', jsonb_build_object('domain', $7::text), now()
        )
        RETURNING analysis_run_id
      `,
      [
        `budget-run:${unique}`,
        anonymousSessionId,
        userId,
        workspaceId,
        pathId,
        actor === "anonymous" ? "weak" : "medium",
        `budget-${unique}.example`
      ]
    )
  ).rows[0]!.analysis_run_id;
  const model = actor === "anonymous" ? "mock-fast" : "mock-standard";
  const modelProfile = providerModelProfile("mock", model);
  assert.ok(modelProfile);
  await pool.query(
    `INSERT INTO analysis_run_provider_models
       (analysis_run_id, provider, model, model_profile_version, ordinal)
     VALUES ($1, 'mock', $2, $3, 0)`,
    [analysisRunId, model, modelProfile.modelProfileVersion]
  );
  const itemId = (
    await pool.query<{ analysis_run_item_id: string }>(
      `
        INSERT INTO analysis_run_items (
          idempotency_key, analysis_run_id, entity_path_id,
          item_ordinal, status, started_at
        )
        VALUES ($1, $2, $3, 0, 'processing', now())
        RETURNING analysis_run_item_id
      `,
      [`budget-item:${unique}`, analysisRunId, pathId]
    )
  ).rows[0]!.analysis_run_item_id;
  const llmRunId = (
    await pool.query<{ llm_run_id: string }>(
      `
        INSERT INTO llm_runs (
          idempotency_key, analysis_run_item_id, status, started_at
        )
        VALUES ($1, $2, 'processing', now())
        RETURNING llm_run_id
      `,
      [`budget-llm:${unique}`, itemId]
    )
  ).rows[0]!.llm_run_id;

  const jobs: Array<{
    providerJobId: string;
    promptJobId: string;
    promptText: string;
    promptType: PromptType;
    promptDepth: "weak" | "medium";
    model: string;
    payload: ProviderJobCreatedPayload;
  }> = [];
  for (const [index, promptType] of promptTypes.entries()) {
    const promptDepth = actor === "anonymous" ? "weak" : "medium";
    const promptPolicy = promptTypePolicy(promptType);
    const promptText =
      `Canonical ${promptType} prompt for ${unique} item ${index}.`;
    const entityPathContext = {
      domain: {
        id: domainId,
        name: `budget-${unique}.example`
      },
      canonicalPath: `budget-${unique}.example`,
      startingLevel: "domain",
      targetLevel: "domain"
    };
    const promptJobId = (
      await pool.query<{ prompt_job_id: string }>(
        `
          INSERT INTO prompt_jobs (
            idempotency_key, llm_run_id, prompt_type, prompt_depth,
            business_prompt_version, response_contract_version,
            status, prompt_text, input_payload, started_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7, $8, now())
          RETURNING prompt_job_id
        `,
        [
          `budget-prompt:${unique}:${promptType}:${index}`,
          llmRunId,
          promptType,
          promptDepth,
          promptPolicy.businessPromptVersion,
          promptPolicy.responseContractVersion,
          promptText,
          { entityPathContext }
        ]
      )
    ).rows[0]!.prompt_job_id;
    const providerJobId = (
      await pool.query<{ provider_job_id: string }>(
        `
          INSERT INTO provider_jobs (
            idempotency_key, job_kind, prompt_job_id, provider, model,
            response_contract_version, provider_instruction_profile,
            model_profile_version, structured_output_mode, request_payload,
            status
          )
          VALUES (
            $1, 'normal_prompt', $2, 'mock', $3, $4,
            'mock-json-schema-v1', $5, 'json_schema', $6, 'queued'
          )
          RETURNING provider_job_id
        `,
        [
          `budget-provider:${unique}:${promptType}:${index}`,
          promptJobId,
          model,
          promptPolicy.responseContractVersion,
          modelProfile.modelProfileVersion,
          {
            entityPathContext
          }
        ]
      )
    ).rows[0]!.provider_job_id;
    jobs.push({
      providerJobId,
      promptJobId,
      promptText,
      promptType,
      promptDepth,
      model,
      payload: {
        providerJobId
      }
    });
  }
  return {
    analysisRunId,
    anonymousSessionId,
    userId,
    workspaceId,
    jobs
  };
}

function estimateFor(job: {
  promptText: string;
  promptType: PromptType;
  promptDepth: "weak" | "medium";
  model: string;
}) {
  return new TokenEstimatorService().estimate({
    provider: "mock",
    model: job.model,
    promptText: job.promptText,
    promptType: job.promptType,
    promptDepth: job.promptDepth
  });
}

async function createPolicy(
  pool: pg.Pool,
  input: {
    scope:
      | "platform_default"
      | "workspace"
      | "user"
      | "anonymous_session"
      | "analysis_run";
    workspaceId: string | null;
    userId?: string | null;
    anonymousSessionId?: string | null;
    analysisRunId?: string | null;
    model?: string | null;
    mode: "hard" | "soft";
    tokenLimit: number;
  }
) {
  return (
    await pool.query<{ budget_policy_id: string }>(
      `
        INSERT INTO budget_policies (
          budget_scope, workspace_id, user_id, anonymous_session_id,
          analysis_run_id, provider, model, limit_mode,
          window_seconds, token_limit
        )
        VALUES ($1, $2, $3, $4, $5, 'mock', $6, $7, 3600, $8)
        RETURNING budget_policy_id
      `,
      [
        input.scope,
        input.workspaceId,
        input.userId ?? null,
        input.anonymousSessionId ?? null,
        input.analysisRunId ?? null,
        input.model ?? null,
        input.mode,
        input.tokenLimit
      ]
    )
  ).rows[0]!.budget_policy_id;
}

async function applicableScopes(
  pool: pg.Pool,
  fixture: Awaited<ReturnType<typeof seedRun>>
) {
  return (
    await new BudgetRepository(pool).lockApplicablePolicies({
      provider: "mock",
      model: fixture.jobs[0]!.model,
      workspaceId: fixture.workspaceId,
      userId: fixture.userId,
      anonymousSessionId: fixture.anonymousSessionId,
      analysisRunId: fixture.analysisRunId
    })
  ).map((policy) => policy.budgetScope);
}

async function truncatePublicTables(pool: pg.Pool) {
  const tables = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  await pool.query(
    `TRUNCATE ${tables.rows
      .map((row) => `"${row.tablename}"`)
      .join(", ")} RESTART IDENTITY CASCADE`
  );
}

async function count(pool: pg.Pool, table: string) {
  const allowed = new Set([
    "provider_results",
    "token_usage",
    "provider_scores",
    "reports",
    "failure_records"
  ]);
  if (!allowed.has(table)) throw new Error("Unsupported count table");
  return Number(
    (await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`))
      .rows[0]!.count
  );
}

async function runStatus(pool: pg.Pool, analysisRunId: string) {
  return (
    await pool.query<{ status: string }>(
      "SELECT status FROM analysis_runs WHERE analysis_run_id = $1",
      [analysisRunId]
    )
  ).rows[0]!.status;
}

async function providerStatus(pool: pg.Pool, providerJobId: string) {
  return (
    await pool.query<{ status: string }>(
      "SELECT status FROM provider_jobs WHERE provider_job_id = $1",
      [providerJobId]
    )
  ).rows[0]!.status;
}

async function providerStatuses(pool: pg.Pool, analysisRunId: string) {
  return (
    await pool.query<{ status: string }>(
      `
        SELECT provider_job.status
        FROM provider_jobs AS provider_job
        JOIN prompt_jobs AS prompt
          ON prompt.prompt_job_id = provider_job.prompt_job_id
        JOIN llm_runs AS llm
          ON llm.llm_run_id = prompt.llm_run_id
        JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = llm.analysis_run_item_id
        WHERE item.analysis_run_id = $1
        ORDER BY provider_job.status
      `,
      [analysisRunId]
    )
  ).rows.map((row) => row.status);
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
  throw new Error("Timed out waiting for Budget worker outcome");
}
