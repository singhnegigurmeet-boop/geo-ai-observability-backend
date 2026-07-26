import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ConfirmChannel } from "amqplib";
import type pg from "pg";
import { createAnalysisModule } from "../../../src/modules/analysis/analysis.module.js";
import { AnalysisRunExpansionService } from "../../../src/modules/analysis/services/analysis-run-expansion.service.js";
import { AnalysisRunItemWorker } from "../../../src/modules/analysis/workers/analysis-run-item-worker.js";
import { AnalysisRunWorker } from "../../../src/modules/analysis/workers/analysis-run-worker.js";
import { createApp } from "../../../src/app.js";
import { AnonymousSessionRepository } from "../../../src/modules/identity/repositories/anonymous-session.repository.js";
import { AnonymousSessionService } from "../../../src/modules/identity/services/anonymous-session.service.js";
import { SessionTokenService } from "../../../src/modules/identity/services/session-token.service.js";
import { UserProvisioningService } from "../../../src/modules/identity/services/user-provisioning.service.js";
import { UserRepository } from "../../../src/modules/identity/repositories/user.repository.js";
import { UserSessionRepository } from "../../../src/modules/identity/repositories/user-session.repository.js";
import { UserSessionService } from "../../../src/modules/identity/services/user-session.service.js";
import { LlmRunCreationService } from "../../../src/modules/llm/services/llm-run-creation.service.js";
import { LlmRunWorker } from "../../../src/modules/llm/workers/llm-run-worker.js";
import { deadLetterQueueName } from "../../../src/common/messaging/queue-names.js";
import type { RabbitMqConnection } from "../../../src/common/messaging/rabbitmq.connection.js";
import { RabbitMqPublisher } from "../../../src/common/messaging/rabbitmq.publisher.js";
import { NotificationService } from "../../../src/modules/notifications/services/notification.service.js";
import { NotificationWorker } from "../../../src/modules/notifications/workers/notification-worker.js";
import { OutboxDispatcher } from "../../../src/modules/outbox/services/outbox.dispatcher.js";
import { OutboxRepository } from "../../../src/modules/outbox/repositories/outbox.repository.js";
import { PromptExecutionService } from "../../../src/modules/prompts/services/prompt-execution.service.js";
import { PromptPlanningService } from "../../../src/modules/prompts/services/prompt-planning.service.js";
import { PromptWorker } from "../../../src/modules/prompts/workers/prompt-worker.js";
import { ProviderAdapterRegistry } from "../../../src/modules/providers/adapters/provider-adapter.registry.js";
import type {
  ProviderAdapter,
  ProviderExecutionRequest
} from "../../../src/modules/providers/types/provider-adapter.types.js";
import { ProviderExecutionError } from "../../../src/modules/providers/errors/provider-execution.error.js";
import { ProviderExecutionService } from "../../../src/modules/providers/services/provider-execution.service.js";
import { MockProviderService } from "../../../src/modules/providers/services/mock-provider.service.js";
import { MockProviderWorker } from "../../../src/modules/providers/workers/mock-provider-worker.js";
import { ProviderWorker } from "../../../src/modules/providers/workers/provider-worker.js";
import { FailureRecordRepository } from "../../../src/modules/reliability/repositories/failure-record.repository.js";
import { AnalysisRunItemWorkerRuntime } from "../../../src/modules/analysis/runtime/analysis-run-item-worker.runtime.js";
import { AnalysisRunWorkerRuntime } from "../../../src/modules/analysis/runtime/analysis-run-worker.runtime.js";
import { ClassificationWorkerRuntime } from "../../../src/modules/analysis/runtime/classification-worker.runtime.js";
import { ClassificationResultWorkerRuntime } from "../../../src/modules/analysis/runtime/classification-result-worker.runtime.js";
import { ClassificationWorker } from "../../../src/modules/analysis/workers/classification-worker.js";
import { ClassificationResultWorker } from "../../../src/modules/analysis/workers/classification-result-worker.js";
import { ClassificationPlanningService } from "../../../src/modules/analysis/services/classification-planning.service.js";
import { ClassificationResultService } from "../../../src/modules/analysis/services/classification-result.service.js";
import { LlmRunWorkerRuntime } from "../../../src/modules/llm/runtime/llm-run-worker.runtime.js";
import { MockProviderWorkerRuntime } from "../../../src/modules/providers/runtime/mock-provider-worker.runtime.js";
import { NotificationWorkerRuntime } from "../../../src/modules/notifications/runtime/notification-worker.runtime.js";
import { PromptWorkerRuntime } from "../../../src/modules/prompts/runtime/prompt-worker.runtime.js";
import { ProviderScoreWorkerRuntime } from "../../../src/modules/scoring/runtime/provider-score-worker.runtime.js";
import { ProviderWorkerRuntime } from "../../../src/modules/providers/runtime/provider-worker.runtime.js";
import type { ReliableQueueWorkerRuntime } from "../../../src/modules/providers/runtime/reliable-queue-worker.runtime.js";
import { SchedulerService } from "../../../src/modules/scheduler/services/scheduler.service.js";
import { ProviderScoreService } from "../../../src/modules/scoring/services/provider-score.service.js";
import { ProviderScoreWorker } from "../../../src/modules/scoring/workers/provider-score-worker.js";
import type { PromptType } from "../../../src/common/types/database.types.js";
import {
  createIntegrationPool,
  createIntegrationRabbitMq,
  pollUntil,
  purgeAllQueues,
  resetTestSchema,
  TEST_MAIN_EXCHANGE,
  truncatePublicTables
} from "../../support/integration-environment.js";

const enabled = process.env.RUN_V6_E2E_TESTS === "true";
const fullEnabled = process.env.RUN_V6_FULL_E2E_TESTS === "true";
const tokenPepper = "v6-e2e-session-token-pepper-at-least-32-characters";
const promptRoutes = [
  ["competitor", "competitor_prompt_queue"],
  ["ranking", "ranking_prompt_queue"],
  ["visibility", "visibility_prompt_queue"],
  ["price_range", "price_range_prompt_queue"],
  ["pros_cons", "pros_cons_prompt_queue"]
] as const;
const quietLogger = {
  info() {},
  warn() {},
  error() {}
};

describe("GEO V6 final end-to-end runtime", {
  skip: !enabled,
  concurrency: 1
}, () => {
  let pool: pg.Pool;
  let rabbitMq: RabbitMqConnection;
  let channel: ConfirmChannel;
  let dispatcher: OutboxDispatcher;
  let adapter: ControlledOpenAiAdapter;
  let runtimes: ReliableQueueWorkerRuntime[];
  let server: Awaited<ReturnType<typeof listen>>;

  before(async () => {
    pool = createIntegrationPool();
    await resetTestSchema(pool);
    rabbitMq = createIntegrationRabbitMq();
    channel = await rabbitMq.getConfirmChannel();
    await purgeAllQueues(channel);
    adapter = new ControlledOpenAiAdapter();
    runtimes = createRuntimes(pool, channel, adapter);
    for (const runtime of runtimes) await runtime.start();
    dispatcher = new OutboxDispatcher(
      new OutboxRepository(pool),
      new RabbitMqPublisher(rabbitMq, {
        exchange: TEST_MAIN_EXCHANGE,
        confirmTimeoutMs: 5_000
      }),
      {
        dispatcherId: "v6-e2e",
        batchSize: 100,
        pollIntervalMs: 10,
        lockTimeoutMs: 10_000,
        retryBaseMs: 10,
        retryMaxMs: 100
      },
      quietLogger
    );
    server = await listen(
      createApp({
        analysisRouter: createAnalysisModule(pool, {
          sessionTokenPepper: tokenPepper,
          userSessionTtlSeconds: 3_600,
          anonymousSessionTtlSeconds: 3_600,
          realProvidersEnabled: true
        })
      })
    );
  });

  beforeEach(async () => {
    adapter.reset();
    await truncatePublicTables(pool);
    await purgeAllQueues(channel);
  });

  after(async () => {
    await server?.close();
    await Promise.allSettled(runtimes?.map((runtime) => runtime.stop()) ?? []);
    await rabbitMq?.close();
    await pool?.end();
  });

  it("runs a successful multi-provider request through API, outbox, workers, reports, and notifications", async () => {
    const owner = await createUserOwner(pool, "success");
    await seedHierarchy(pool, "success.example");
    const preview = await previewAnalysis(
      server.url,
      owner,
      "success.example",
      multiProviderSet()
    );
    assert.equal(preview.status, 200);
    const created = await postAnalysis(
      server.url,
      owner,
      "success-e2e",
      "success.example",
      multiProviderSet()
    );
    assert.equal(created.status, 202);
    const frozenIdentity = await pool.query<{
      canonical_hash: string;
    }>(
      `SELECT request_payload->>'canonicalRequestHash' AS canonical_hash
       FROM analysis_runs WHERE analysis_run_id = $1`,
      [created.body.analysisRunId]
    );
    assert.equal(
      frozenIdentity.rows[0]?.canonical_hash,
      preview.body.canonicalRequestHash
    );
    assert.equal(preview.body.normalProviderJobCountEstimate.minimum, 6);
    assert.equal(
      preview.body.totalProviderJobCountEstimate.minimum,
      6 + preview.body.classificationProviderJobCount
    );

    await driveUntil(
      dispatcher,
      async () => (await runStatus(pool, created.body.analysisRunId)) === "completed",
      "successful run completion"
    );
    await driveUntil(
      dispatcher,
      async () => (await sentReportNotifications(pool, created.body.analysisRunId)) > 0,
      "report notification delivery"
    );

    const shape = await executionShape(pool, created.body.analysisRunId);
    assert.deepEqual(shape, {
      prompts: 3,
      providerJobs: 6,
      providerResults: 6,
      providerScores: 4,
      actualUsage: 6
    });
    assert.ok(
      (
        await pool.query(
          `SELECT prompt.prompt_job_id
           FROM prompt_jobs AS prompt
           JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
           JOIN analysis_run_items AS item
             ON item.analysis_run_item_id = llm.analysis_run_item_id
           JOIN provider_jobs AS job
             ON job.prompt_job_id = prompt.prompt_job_id
           WHERE item.analysis_run_id = $1
           GROUP BY prompt.prompt_job_id
           HAVING count(job.provider_job_id) <> 2`,
          [created.body.analysisRunId]
        )
      ).rows.length === 0
    );
    const latest = await latestReport(pool, created.body.analysisRunId);
    assert.equal(latest.report_data.final, true);
    assert.equal(latest.report_data.lifecycleState, "completed");
    assert.equal(
      latest.report_data.reportVersion,
      "multi-provider-geo-report-v3"
    );
    assert.equal(
      latest.report_data.methodology.scoringVersion,
      "geo-scoring-v2"
    );
    assert.ok(latest.report_data.usageAndCost.planningEstimate);
    assert.equal(
      latest.report_data.usageAndCost.actual.totalTokens,
      latest.report_data.providerResults.reduce(
        (
          total: number,
          result: { usage: { inputTokens: number; outputTokens: number } }
        ) => total + result.usage.inputTokens + result.usage.outputTokens,
        0
      )
    );
    assert.equal(Array.isArray(latest.report_data.promptOutcomes), true);
    assert.equal(Array.isArray(latest.report_data.visibility), true);
    assert.equal(Array.isArray(latest.report_data.ranking), true);
    assert.equal(Array.isArray(latest.report_data.competitors), true);
    assert.equal(
      JSON.stringify(latest.report_data).includes("validationErrors"),
      false
    );
    assert.deepEqual(
      new Set(
        (latest.report_data.providerResults as Array<{ provider: string }>).map(
          (result) => result.provider
        )
      ),
      new Set(["mock", "openai"])
    );
    assert.ok((await reportCount(pool, created.body.analysisRunId)) > 1);

    const publicReport = await getReport(
      server.url,
      created.body.analysisRunId,
      owner
    );
    assert.equal(publicReport.status, 200);
    const unrelated = await createUserOwner(pool, "success-unrelated");
    assert.equal(
      (await getReport(server.url, created.body.analysisRunId, unrelated))
        .status,
      404
    );
  });

  it("terminalizes exhausted provider failure without losing successful sibling evidence", async () => {
    adapter.set("failure.example", "retry_failure");
    const owner = await createUserOwner(pool, "failure");
    await seedHierarchy(pool, "failure.example");
    const created = await postAnalysis(
      server.url,
      owner,
      "failure-e2e",
      "failure.example",
      multiProviderSet()
    );

    await driveUntil(
      dispatcher,
      async () =>
        (await runStatus(pool, created.body.analysisRunId)) === "failed" &&
        (await failedProviderJobs(pool, created.body.analysisRunId)) === 3,
      "terminal gap-aware failure"
    );
    await driveUntil(
      dispatcher,
      async () =>
        (
          await pool.query<{ count: string }>(
            `SELECT count(*) FROM notifications
             WHERE is_admin_notification AND status = 'sent'`
          )
        ).rows[0]?.count !== "0",
      "admin failure notification"
    );
    const latest = await latestReport(pool, created.body.analysisRunId);
    assert.equal(latest.report_data.final, true);
    assert.equal(latest.report_data.lifecycleState, "completed_with_gaps");
    assert.equal(latest.report_data.counts.scored, 2);
    assert.equal(latest.report_data.counts.failed, 3);
    assert.equal(await scoreCount(pool, created.body.analysisRunId), 2);
    assert.ok((await resultCount(pool, created.body.analysisRunId)) >= 3);
    const deadLetter = await channel.get(deadLetterQueueName("openai_queue"), {
      noAck: false
    });
    assert.ok(deadLetter);
    if (deadLetter) channel.ack(deadLetter);
  });

  it("creates a budget-paused partial report without technical failure or DLQ", async () => {
    const owner = await createUserOwner(pool, "budget");
    await seedHierarchy(pool, "budget.example");
    await pool.query(
       `INSERT INTO budget_policies (
         budget_scope, workspace_id, provider, limit_mode, window_seconds, token_limit
       ) VALUES ('workspace', $1, 'mock', 'soft', 3600, 1)`,
      [owner.workspaceId]
    );
    const created = await postAnalysis(
      server.url,
      owner,
      "budget-e2e",
      "budget.example",
      [{ provider: "mock", model: "mock-standard" }]
    );

    await driveUntil(
      dispatcher,
      async () =>
        (await runStatus(pool, created.body.analysisRunId)) === "paused_budget",
      "budget pause"
    );
    await driveUntil(
      dispatcher,
      async () =>
        (await latestReport(pool, created.body.analysisRunId).catch(() => null))
          ?.report_data.lifecycleState === "budget_paused_partial",
      "budget partial report"
    );
    const latest = await latestReport(pool, created.body.analysisRunId);
    assert.equal(latest.report_data.final, false);
    assert.ok(Number(latest.report_data.counts.scored) > 0);
    assert.equal(await failureCount(pool), 0);
    assert.equal(
      await channel.get(deadLetterQueueName("mock_queue"), { noAck: true }),
      false
    );
  });

  it("retains malformed successful evidence as invalid and unscored coverage", async () => {
    adapter.set("invalid.example", "invalid");
    const owner = await createUserOwner(pool, "invalid");
    await seedHierarchy(pool, "invalid.example");
    const created = await postAnalysis(
      server.url,
      owner,
      "invalid-e2e",
      "invalid.example",
      multiProviderSet()
    );

    await driveUntil(
      dispatcher,
      async () =>
        (await runStatus(pool, created.body.analysisRunId)) ===
        "partial_success",
      "invalid-evidence completion"
    );
    const invalid = await pool.query<{
      count: string;
      scored: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE result.status = 'invalid')::text AS count,
         count(score.provider_score_id) FILTER (
           WHERE result.status = 'invalid'
         )::text AS scored
       FROM analysis_run_items AS item
       JOIN llm_runs AS llm
         ON llm.analysis_run_item_id = item.analysis_run_item_id
       JOIN prompt_jobs AS prompt ON prompt.llm_run_id = llm.llm_run_id
       JOIN provider_jobs AS job ON job.prompt_job_id = prompt.prompt_job_id
       JOIN provider_results AS result
         ON result.provider_job_id = job.provider_job_id
       LEFT JOIN provider_scores AS score
         ON score.provider_result_id = result.provider_result_id
       WHERE item.analysis_run_id = $1`,
      [created.body.analysisRunId]
    );
    assert.deepEqual(invalid.rows[0], { count: "3", scored: "0" });
    const latest = await latestReport(pool, created.body.analysisRunId);
    assert.equal(latest.report_data.counts.invalid, 3);
    assert.equal(latest.report_data.counts.scored, 2);
  });

  it("supports pre-provider cancellation, rejects late cancellation, and no-ops delayed messages", async () => {
    const owner = await createUserOwner(pool, "cancel");
    await seedHierarchy(pool, "cancel.example");
    const early = await postAnalysis(
      server.url,
      owner,
      "cancel-early",
      "cancel.example",
      [{ provider: "mock", model: "mock-standard" }]
    );
    const cancellation = await fetch(
      `${server.url}/v1/analysis/runs/${early.body.analysisRunId}/cancel`,
      { method: "POST", headers: owner.headers }
    );
    assert.equal(cancellation.status, 200);
    await driveFor(dispatcher, 500);
    assert.equal(await runStatus(pool, early.body.analysisRunId), "cancelled");
    assert.equal(
      (await latestReport(pool, early.body.analysisRunId)).report_data
        .lifecycleState,
      "cancelled_empty"
    );
    assert.equal(await failureCount(pool), 0);

    const late = await postAnalysis(
      server.url,
      owner,
      "cancel-late",
      "cancel.example",
      [{ provider: "mock", model: "mock-standard" }]
    );
    await driveUntil(
      dispatcher,
      async () =>
        (
          await pool.query<{ count: string }>(
            `SELECT count(*) FROM provider_jobs AS job
             JOIN prompt_jobs AS prompt
               ON prompt.prompt_job_id = job.prompt_job_id
             JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
             JOIN analysis_run_items AS item
               ON item.analysis_run_item_id = llm.analysis_run_item_id
             WHERE item.analysis_run_id = $1
               AND (job.started_at IS NOT NULL OR job.status = 'succeeded')`,
            [late.body.analysisRunId]
          )
        ).rows[0]?.count !== "0",
      "provider start"
    );
    assert.equal(
      (
        await fetch(
          `${server.url}/v1/analysis/runs/${late.body.analysisRunId}/cancel`,
          { method: "POST", headers: owner.headers }
        )
      ).status,
      409
    );
  });

  it("grants an exact claimant access to a completed pre-claim anonymous run", async () => {
    const anonymous = await createAnonymousOwner(pool);
    await seedHierarchy(pool, "claim.example");
    const created = await postAnalysis(
      server.url,
      anonymous,
      "claim-e2e",
      "claim.example"
    );
    await driveUntil(
      dispatcher,
      async () => (await runStatus(pool, created.body.analysisRunId)) === "completed",
      "anonymous completion"
    );
    const claimant = await createUserOwner(pool, "claimant");
    await anonymous.service.claim({
      anonymousSessionId: anonymous.anonymousSessionId,
      userId: claimant.userId,
      workspaceId: claimant.workspaceId
    });
    const claimedHeaders = {
      ...claimant.headers,
      "x-anonymous-session-token": anonymous.token
    };
    assert.equal(
      (
        await fetch(
          `${server.url}/v1/analysis/runs/${created.body.analysisRunId}/report`,
          { headers: claimedHeaders }
        )
      ).status,
      200
    );
    const unrelated = await createUserOwner(pool, "claim-unrelated");
    assert.equal(
      (await getReport(server.url, created.body.analysisRunId, unrelated))
        .status,
      404
    );
  });

  it("creates one valid scheduled run and safely pauses invalid owner and hierarchy schedules", async () => {
    const dueAt = new Date("2026-07-25T00:00:00.000Z");
    const validOwner = await createUserOwner(pool, "schedule-valid");
    const validPath = await seedHierarchy(pool, "schedule-valid.example");
    await insertSchedule(pool, validOwner, validPath, dueAt, "valid");
    const scheduler = new SchedulerService(pool, true);
    assert.equal((await scheduler.tick(dueAt)).outcome, "enqueued");
    await driveUntil(
      dispatcher,
      async () =>
        (
          await pool.query<{ count: string }>(
            "SELECT count(*) FROM analysis_runs WHERE source = 'scheduled'"
          )
        ).rows[0]?.count === "1",
      "scheduled run creation"
    );

    const invalidOwner = await createUserOwner(pool, "schedule-owner-invalid");
    const ownerPath = await seedHierarchy(pool, "schedule-owner-invalid.example");
    await insertSchedule(pool, invalidOwner, ownerPath, dueAt, "owner-invalid");
    await pool.query("UPDATE users SET status = 'disabled' WHERE user_id = $1", [
      invalidOwner.userId
    ]);
    assert.equal((await scheduler.tick(dueAt)).outcome, "failed");

    const hierarchyOwner = await createUserOwner(
      pool,
      "schedule-hierarchy-invalid"
    );
    const hierarchyPath = await seedHierarchy(
      pool,
      "schedule-hierarchy-invalid.example"
    );
    await insertSchedule(
      pool,
      hierarchyOwner,
      hierarchyPath,
      dueAt,
      "hierarchy-invalid"
    );
    await pool.query(
      `UPDATE domains SET is_active = false
       WHERE domain_id = (
         SELECT domain_id FROM entity_paths WHERE entity_path_id = $1
       )`,
      [hierarchyPath]
    );
    assert.equal((await scheduler.tick(dueAt)).outcome, "failed");
    const state = await pool.query<{ status: string }>(
      `SELECT status FROM scheduler_jobs
       WHERE idempotency_key IN (
         'e2e-schedule-owner-invalid',
         'e2e-schedule-hierarchy-invalid'
       ) ORDER BY idempotency_key`
    );
    assert.deepEqual(state.rows, [{ status: "paused" }, { status: "paused" }]);
    assert.equal(
      (
        await pool.query<{ count: string }>(
          "SELECT count(*) FROM analysis_runs WHERE source = 'scheduled'"
        )
      ).rows[0]?.count,
      "1"
    );
  });

  it("returns completed_empty without technical failure when expansion has no target", async () => {
    const owner = await createUserOwner(pool, "empty");
    const emptyCategoryId = await seedCategoryOnly(
      pool,
      "empty.example"
    );
    const created = await postAnalysis(
      server.url,
      owner,
      "empty-e2e",
      "empty.example",
      [{ provider: "mock", model: "mock-standard" }],
      { categoryId: emptyCategoryId }
    );
    await driveUntil(
      dispatcher,
      async () => (await runStatus(pool, created.body.analysisRunId)) === "completed",
      "completed-empty outcome"
    );
    const emptyReport = await latestReport(pool, created.body.analysisRunId);
    assert.equal(emptyReport.report_data.lifecycleState, "completed_empty");
    assert.equal(
      emptyReport.report_data.reason,
      "no_applicable_analysis_item"
    );
    assert.equal(await failureCount(pool), 0);
    assert.equal(
      await channel.get(deadLetterQueueName("analysis_run_queue"), {
        noAck: true
      }),
      false
    );
  });

  it("classifies a domain against the frozen candidate set before expansion", async () => {
    const owner = await createUserOwner(pool, "classification");
    const categoryId = await seedClassificationCandidate(
      pool,
      "classification.example"
    );
    const created = await postAnalysis(
      server.url,
      owner,
      "classification-e2e",
      "classification.example",
      [{ provider: "mock", model: "mock-standard" }],
      {
        categorySelection: {
          mode: "selected",
          categoryIds: [categoryId]
        }
      }
    );
    assert.equal(created.status, 202);
    await driveUntil(
      dispatcher,
      async () =>
        (await runStatus(pool, created.body.analysisRunId)) === "completed",
      "classification-driven completion"
    );
    const evidence = await pool.query<{
      classification_status: string;
      source: string;
      classification_rank: number;
      provider_results: string;
    }>(
      `SELECT classification.status AS classification_status,
              relationship.source,
              relationship.classification_rank,
              count(result.provider_result_id)::text AS provider_results
       FROM domain_category_classification_jobs AS classification
       JOIN provider_jobs AS job
         ON job.classification_job_id =
            classification.domain_category_classification_job_id
       JOIN provider_results AS result
         ON result.provider_job_id = job.provider_job_id
       JOIN domain_categories AS relationship
         ON relationship.classification_provider_result_id =
            result.provider_result_id
       WHERE classification.analysis_run_id = $1
       GROUP BY classification.status, relationship.domain_category_id`,
      [created.body.analysisRunId]
    );
    assert.deepEqual(evidence.rows, [
      {
        classification_status: "completed",
        source: "llm_classification",
        classification_rank: 1,
        provider_results: "1"
      }
    ]);
    assert.deepEqual(await executionShape(pool, created.body.analysisRunId), {
      prompts: 3,
      providerJobs: 3,
      providerResults: 3,
      providerScores: 2,
      actualUsage: 3
    });
    assert.equal(
      (await latestReport(pool, created.body.analysisRunId)).report_data
        .classification.evidenceStatus,
      "valid"
    );
  });

  it("preserves canonical idempotency and uniqueness under concurrent requests and provider completion", async () => {
    const owner = await createUserOwner(pool, "concurrency");
    await seedHierarchy(pool, "concurrency.example");
    const forward = multiProviderSet();
    const reverse = [...forward].reverse();
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        postAnalysis(
          server.url,
          owner,
          "concurrent-e2e",
          "concurrency.example",
          index % 2 === 0 ? forward : reverse
        )
      )
    );
    assert.ok(responses.every((response) => response.status === 202));
    const runIds = new Set(
      responses.map((response) => response.body.analysisRunId)
    );
    assert.equal(runIds.size, 1);
    const runId = [...runIds][0]!;

    await driveUntil(
      dispatcher,
      async () => (await runStatus(pool, runId)) === "completed",
      "concurrent provider completion"
    );
    assert.deepEqual(await executionShape(pool, runId), {
      prompts: 3,
      providerJobs: 6,
      providerResults: 6,
      providerScores: 4,
      actualUsage: 6
    });
    const revisions = await pool.query<{
      revision: number;
      count: string;
    }>(
      `SELECT revision, count(*)::text
       FROM reports WHERE analysis_run_id = $1
       GROUP BY revision HAVING count(*) > 1`,
      [runId]
    );
    assert.deepEqual(revisions.rows, []);
    assert.equal(
      (
        await postAnalysis(
          server.url,
          owner,
          "concurrent-e2e",
          "concurrency.example",
          [{ provider: "mock", model: "mock-standard" }]
        )
      ).status,
      409
    );
  });

  if (fullEnabled) {
  it("repeats the high-contention idempotency and provider-completion regression", async () => {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      await truncatePublicTables(pool);
      await purgeAllQueues(channel);
      const owner = await createUserOwner(pool, `full-contention-${repetition}`);
      const domain = `full-contention-${repetition}.example`;
      await seedHierarchy(pool, domain);
      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          postAnalysis(
            server.url,
            owner,
            `full-contention-${repetition}`,
            domain,
            index % 2 === 0
              ? multiProviderSet()
              : [...multiProviderSet()].reverse()
          )
        )
      );
      assert.ok(responses.every((response) => response.status === 202));
      const runIds = new Set(
        responses.map((response) => response.body.analysisRunId)
      );
      assert.equal(runIds.size, 1);
      const runId = [...runIds][0]!;
      await driveUntil(
        dispatcher,
        async () => (await runStatus(pool, runId)) === "completed",
        `full contention repetition ${repetition}`
      );
      assert.deepEqual(await executionShape(pool, runId), {
        prompts: 3,
        providerJobs: 6,
        providerResults: 6,
        providerScores: 4,
        actualUsage: 6
      });
      const duplicates = await pool.query(
        `SELECT idempotency_key
         FROM reports
         WHERE analysis_run_id = $1
         GROUP BY idempotency_key
         HAVING count(*) > 1`,
        [runId]
      );
      assert.deepEqual(duplicates.rows, []);
    }
  });

  it("recovers pending work after dispatcher and worker process restart", async () => {
    const owner = await createUserOwner(pool, "full-restart");
    await seedHierarchy(pool, "full-restart.example");
    const created = await postAnalysis(
      server.url,
      owner,
      "full-restart",
      "full-restart.example",
      multiProviderSet()
    );
    assert.equal(created.status, 202);

    await Promise.all(runtimes.map((runtime) => runtime.stop()));
    runtimes = [];
    await server.close();
    server = await listen(
      createApp({
        analysisRouter: createAnalysisModule(pool, {
          sessionTokenPepper: tokenPepper,
          userSessionTtlSeconds: 3_600,
          anonymousSessionTtlSeconds: 3_600,
          realProvidersEnabled: true
        })
      })
    );
    await dispatcher.dispatchBatch();

    runtimes = createRuntimes(pool, channel, adapter);
    for (const runtime of runtimes) await runtime.start();
    dispatcher = createDispatcher(pool, rabbitMq, "v6-e2e-restarted");
    await driveUntil(
      dispatcher,
      async () =>
        (await runStatus(pool, created.body.analysisRunId)) === "completed",
      "process restart recovery"
    );
    assert.deepEqual(await executionShape(pool, created.body.analysisRunId), {
      prompts: 3,
      providerJobs: 6,
      providerResults: 6,
      providerScores: 4,
      actualUsage: 6
    });
  });

  it("keeps outbox work retryable through RabbitMQ outage and recovery", async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop()));
    runtimes = [];
    await rabbitMq.close();

    const owner = await createUserOwner(pool, "full-broker-recovery");
    await seedHierarchy(pool, "full-broker-recovery.example");
    const created = await postAnalysis(
      server.url,
      owner,
      "full-broker-recovery",
      "full-broker-recovery.example",
      multiProviderSet()
    );
    assert.equal(created.status, 202);
    await dispatcher.dispatchBatch();
    const pending = await pool.query<{
      attempt_count: number;
      published_at: Date | null;
    }>(
      `SELECT attempt_count, published_at
       FROM outbox_events
       WHERE aggregate_type = 'analysis_run' AND aggregate_id = $1`,
      [created.body.analysisRunId]
    );
    assert.ok((pending.rows[0]?.attempt_count ?? 0) >= 1);
    assert.equal(pending.rows[0]?.published_at, null);

    rabbitMq = createIntegrationRabbitMq();
    channel = await rabbitMq.getConfirmChannel();
    runtimes = createRuntimes(pool, channel, adapter);
    for (const runtime of runtimes) await runtime.start();
    dispatcher = createDispatcher(pool, rabbitMq, "v6-e2e-broker-recovered");
    await driveUntil(
      dispatcher,
      async () =>
        (await runStatus(pool, created.body.analysisRunId)) === "completed",
      "RabbitMQ outage recovery"
    );
    assert.deepEqual(await executionShape(pool, created.body.analysisRunId), {
      prompts: 3,
      providerJobs: 6,
      providerResults: 6,
      providerScores: 4,
      actualUsage: 6
    });
  });
  }

  function createRuntimes(
    database: pg.Pool,
    consumerChannel: ConfirmChannel,
    openAiAdapter: ControlledOpenAiAdapter
  ) {
    const failures = new FailureRecordRepository(database);
    const options = { mainExchange: TEST_MAIN_EXCHANGE, prefetch: 10 };
    const result: ReliableQueueWorkerRuntime[] = [
      new AnalysisRunWorkerRuntime(
        consumerChannel,
        new AnalysisRunWorker(new AnalysisRunExpansionService(database)),
        failures,
        options,
        quietLogger
      ),
      new ClassificationWorkerRuntime(
        consumerChannel,
        new ClassificationWorker(
          new ClassificationPlanningService(database)
        ),
        failures,
        options,
        quietLogger
      ),
      new ClassificationResultWorkerRuntime(
        consumerChannel,
        new ClassificationResultWorker(
          new ClassificationResultService(database)
        ),
        failures,
        options,
        quietLogger
      ),
      new AnalysisRunItemWorkerRuntime(
        consumerChannel,
        new AnalysisRunItemWorker(new LlmRunCreationService(database)),
        failures,
        options,
        quietLogger
      ),
      new LlmRunWorkerRuntime(
        consumerChannel,
        new LlmRunWorker(new PromptPlanningService(database)),
        failures,
        options,
        quietLogger
      )
    ];
    const promptExecution = new PromptExecutionService(
      database,
      undefined,
      true
    );
    for (const [promptType, queueName] of promptRoutes) {
      result.push(
        new PromptWorkerRuntime(
          consumerChannel,
          new PromptWorker(promptType as PromptType, promptExecution),
          failures,
          { ...options, queueName },
          quietLogger
        )
      );
    }
    result.push(
      new MockProviderWorkerRuntime(
        consumerChannel,
        new MockProviderWorker(new MockProviderService(database)),
        failures,
        options,
        quietLogger
      ),
      new ProviderWorkerRuntime(
        consumerChannel,
        new ProviderWorker(
          "openai",
          new ProviderExecutionService(
            database,
            new ProviderAdapterRegistry([openAiAdapter]),
            2_000
          )
        ),
        failures,
        {
          queueName: "openai_queue",
          mainExchange: TEST_MAIN_EXCHANGE,
          prefetch: 10,
          workerLabel: "E2E OpenAI worker"
        },
        quietLogger
      ),
      new ProviderScoreWorkerRuntime(
        consumerChannel,
        new ProviderScoreWorker(new ProviderScoreService(database)),
        failures,
        options,
        quietLogger
      ),
      new NotificationWorkerRuntime(
        consumerChannel,
        new NotificationWorker(new NotificationService(database)),
        failures,
        options,
        quietLogger
      )
    );
    return result;
  }
});

function createDispatcher(
  pool: pg.Pool,
  rabbitMq: RabbitMqConnection,
  dispatcherId: string
) {
  return new OutboxDispatcher(
    new OutboxRepository(pool),
    new RabbitMqPublisher(rabbitMq, {
      exchange: TEST_MAIN_EXCHANGE,
      confirmTimeoutMs: 5_000
    }),
    {
      dispatcherId,
      batchSize: 100,
      pollIntervalMs: 10,
      lockTimeoutMs: 10_000,
      retryBaseMs: 10,
      retryMaxMs: 100
    },
    quietLogger
  );
}

type Owner = {
  userId: string;
  workspaceId: string;
  headers: Record<string, string>;
};

async function createUserOwner(pool: pg.Pool, suffix: string): Promise<Owner> {
  const provisioned = await new UserProvisioningService(
    pool
  ).createUserWithDefaultWorkspace({
    email: `${suffix}-${crypto.randomUUID()}@e2e.example`,
    defaultWorkspaceName: `E2E ${suffix}`
  });
  const session = await new UserSessionService(
    new UserSessionRepository(pool),
    new UserRepository(pool),
    new SessionTokenService(tokenPepper),
    { ttlSeconds: 3_600 }
  ).create(provisioned.user.user_id);
  return {
    userId: provisioned.user.user_id,
    workspaceId: provisioned.workspace.workspace_id,
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-workspace-id": provisioned.workspace.workspace_id,
      "content-type": "application/json"
    }
  };
}

async function createAnonymousOwner(pool: pg.Pool) {
  const service = new AnonymousSessionService(
    new AnonymousSessionRepository(pool),
    pool,
    new SessionTokenService(tokenPepper),
    { ttlSeconds: 3_600 }
  );
  const created = await service.create();
  return {
    service,
    token: created.token,
    anonymousSessionId: created.session.anonymous_session_id,
    headers: {
      "x-anonymous-session-token": created.token,
      "content-type": "application/json"
    }
  };
}

async function seedDomainOnly(pool: pg.Pool, domainName: string) {
  const domain = await pool.query<{ domain_id: string }>(
    `INSERT INTO domains (normalized_domain)
     VALUES ($1)
     ON CONFLICT (normalized_domain) DO UPDATE
       SET normalized_domain = EXCLUDED.normalized_domain
     RETURNING domain_id`,
    [domainName]
  );
  return domain.rows[0]!.domain_id;
}

async function seedHierarchy(pool: pg.Pool, domainName: string) {
  const domainId = await seedDomainOnly(pool, domainName);
  const unique = crypto.randomUUID();
  const category = await pool.query<{ category_id: string }>(
    `INSERT INTO categories (category_name, normalized_name)
     VALUES ($1, $2) RETURNING category_id`,
    [`E2E ${unique}`, `e2e-${unique}`]
  );
  await pool.query(
    `INSERT INTO domain_categories (domain_id, category_id, sort_order)
     VALUES ($1, $2, 0)`,
    [domainId, category.rows[0]!.category_id]
  );
  const path = await pool.query<{ entity_path_id: string }>(
    `INSERT INTO entity_paths (domain_id, path_type)
     VALUES ($1, 'domain')
     ON CONFLICT ON CONSTRAINT entity_paths_hierarchy_unique DO UPDATE
       SET domain_id = EXCLUDED.domain_id
     RETURNING entity_path_id`,
    [domainId]
  );
  return path.rows[0]!.entity_path_id;
}

async function seedCategoryOnly(pool: pg.Pool, domainName: string) {
  const domainId = await seedDomainOnly(pool, domainName);
  const unique = crypto.randomUUID();
  const category = await pool.query<{ category_id: string }>(
    `INSERT INTO categories (category_name, normalized_name)
     VALUES ($1, $2) RETURNING category_id`,
    [`E2E empty ${unique}`, `e2e-empty-${unique}`]
  );
  await pool.query(
    `INSERT INTO domain_categories (domain_id, category_id, sort_order)
     VALUES ($1, $2, 0)`,
    [domainId, category.rows[0]!.category_id]
  );
  return category.rows[0]!.category_id;
}

async function seedClassificationCandidate(
  pool: pg.Pool,
  domainName: string
) {
  await seedDomainOnly(pool, domainName);
  const unique = crypto.randomUUID();
  return (
    await pool.query<{ category_id: string }>(
      `INSERT INTO categories (category_name, normalized_name)
       VALUES ($1, $2) RETURNING category_id`,
      [`E2E candidate ${unique}`, `e2e-candidate-${unique}`]
    )
  ).rows[0]!.category_id;
}

async function postAnalysis(
  baseUrl: string,
  owner: { headers: Record<string, string> },
  idempotencyKey: string,
  domain: string,
  providerModels?: Array<{ provider: string; model: string }>,
  extra: Record<string, unknown> = {}
) {
  const response = await fetch(`${baseUrl}/v1/analysis`, {
    method: "POST",
    headers: {
      ...owner.headers,
      "idempotency-key": idempotencyKey
    },
    body: JSON.stringify(analysisBody(owner, domain, providerModels, extra))
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      analysisRunId: string;
      idempotentReplay: boolean;
    }
  };
}

async function previewAnalysis(
  baseUrl: string,
  owner: { headers: Record<string, string> },
  domain: string,
  providerModels?: Array<{ provider: string; model: string }>,
  extra: Record<string, unknown> = {}
) {
  const response = await fetch(`${baseUrl}/v1/analysis/preview`, {
    method: "POST",
    headers: owner.headers,
    body: JSON.stringify(analysisBody(owner, domain, providerModels, extra))
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>
  };
}

function analysisBody(
  owner: { headers: Record<string, string> },
  domain: string,
  providerModels?: Array<{ provider: string; model: string }>,
  extra: Record<string, unknown> = {}
) {
  const authenticated = "authorization" in owner.headers;
  return {
    domain,
    ...(authenticated ? { promptDepth: "high" } : {}),
    ...(providerModels ? { providerModels } : {}),
    ...extra
  };
}

function getReport(baseUrl: string, runId: string, owner: Owner) {
  return fetch(`${baseUrl}/v1/analysis/runs/${runId}/report`, {
    headers: owner.headers
  });
}

function multiProviderSet() {
  return [
    { provider: "mock", model: "mock-quality" },
    { provider: "openai", model: "gpt-4o-mini" }
  ];
}

async function driveUntil(
  dispatcher: OutboxDispatcher,
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 30_000
) {
  await pollUntil(async () => {
    await dispatcher.dispatchBatch();
    return predicate();
  }, description, timeoutMs);
}

async function driveFor(dispatcher: OutboxDispatcher, milliseconds: number) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    await dispatcher.dispatchBatch();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runStatus(pool: pg.Pool, runId: string) {
  return (
    await pool.query<{ status: string }>(
      "SELECT status FROM analysis_runs WHERE analysis_run_id = $1",
      [runId]
    )
  ).rows[0]?.status;
}

async function latestReport(pool: pg.Pool, runId: string) {
  return (
    await pool.query<{
      revision: number;
      report_data: Record<string, any>;
    }>(
      `SELECT revision, report_data FROM reports
       WHERE analysis_run_id = $1
       ORDER BY revision DESC, report_id DESC LIMIT 1`,
      [runId]
    )
  ).rows[0]!;
}

async function executionShape(pool: pg.Pool, runId: string) {
  const result = await pool.query<{
    prompts: string;
    provider_jobs: string;
    provider_results: string;
    provider_scores: string;
    actual_usage: string;
  }>(
    `SELECT
       count(DISTINCT prompt.prompt_job_id)::text AS prompts,
       count(DISTINCT job.provider_job_id)::text AS provider_jobs,
       count(DISTINCT result.provider_result_id)::text AS provider_results,
       count(DISTINCT score.provider_score_id)::text AS provider_scores,
       count(DISTINCT usage.token_usage_id)::text AS actual_usage
     FROM analysis_run_items AS item
     JOIN llm_runs AS llm
       ON llm.analysis_run_item_id = item.analysis_run_item_id
     JOIN prompt_jobs AS prompt ON prompt.llm_run_id = llm.llm_run_id
     JOIN provider_jobs AS job ON job.prompt_job_id = prompt.prompt_job_id
     LEFT JOIN provider_results AS result
       ON result.provider_job_id = job.provider_job_id
     LEFT JOIN provider_scores AS score
       ON score.provider_result_id = result.provider_result_id
     LEFT JOIN token_usage AS usage
       ON usage.provider_job_id = job.provider_job_id
      AND usage.usage_kind = 'actual'
     WHERE item.analysis_run_id = $1`,
    [runId]
  );
  const row = result.rows[0]!;
  return {
    prompts: Number(row.prompts),
    providerJobs: Number(row.provider_jobs),
    providerResults: Number(row.provider_results),
    providerScores: Number(row.provider_scores),
    actualUsage: Number(row.actual_usage)
  };
}

async function reportCount(pool: pg.Pool, runId: string) {
  return Number(
    (
      await pool.query<{ count: string }>(
        "SELECT count(*) FROM reports WHERE analysis_run_id = $1",
        [runId]
      )
    ).rows[0]!.count
  );
}

async function sentReportNotifications(pool: pg.Pool, runId: string) {
  return Number(
    (
      await pool.query<{ count: string }>(
        `SELECT count(*) FROM notifications
         WHERE analysis_run_id = $1
           AND payload->>'type' = 'report_ready'
           AND status = 'sent'`,
        [runId]
      )
    ).rows[0]!.count
  );
}

async function failedProviderJobs(pool: pg.Pool, runId: string) {
  return Number(
    (
      await pool.query<{ count: string }>(
        `SELECT count(*) FROM provider_jobs AS job
         JOIN prompt_jobs AS prompt ON prompt.prompt_job_id = job.prompt_job_id
         JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
         JOIN analysis_run_items AS item
           ON item.analysis_run_item_id = llm.analysis_run_item_id
         WHERE item.analysis_run_id = $1 AND job.status = 'failed'`,
        [runId]
      )
    ).rows[0]!.count
  );
}

async function scoreCount(pool: pg.Pool, runId: string) {
  return countRunRows(pool, runId, "provider_scores");
}

async function resultCount(pool: pg.Pool, runId: string) {
  return countRunRows(pool, runId, "provider_results");
}

async function countRunRows(
  pool: pg.Pool,
  runId: string,
  table: "provider_results" | "provider_scores"
) {
  const scoreJoin =
    table === "provider_scores"
      ? "JOIN provider_scores AS target ON target.provider_result_id = result.provider_result_id"
      : "JOIN provider_results AS target ON target.provider_job_id = job.provider_job_id";
  const resultJoin =
    table === "provider_scores"
      ? "JOIN provider_results AS result ON result.provider_job_id = job.provider_job_id"
      : "";
  return Number(
    (
      await pool.query<{ count: string }>(
        `SELECT count(DISTINCT target.*) FROM analysis_run_items AS item
         JOIN llm_runs AS llm
           ON llm.analysis_run_item_id = item.analysis_run_item_id
         JOIN prompt_jobs AS prompt ON prompt.llm_run_id = llm.llm_run_id
         JOIN provider_jobs AS job ON job.prompt_job_id = prompt.prompt_job_id
         ${resultJoin}
         ${scoreJoin}
         WHERE item.analysis_run_id = $1`,
        [runId]
      )
    ).rows[0]!.count
  );
}

async function failureCount(pool: pg.Pool) {
  return Number(
    (await pool.query<{ count: string }>("SELECT count(*) FROM failure_records"))
      .rows[0]!.count
  );
}

async function insertSchedule(
  pool: pg.Pool,
  owner: Owner,
  pathId: string,
  dueAt: Date,
  suffix: string
) {
  const category = await pool.query<{ category_id: string }>(
    `SELECT relationship.category_id
     FROM entity_paths AS path
     JOIN domain_categories AS relationship
       ON relationship.domain_id = path.domain_id
      AND relationship.is_active
     WHERE path.entity_path_id = $1
     ORDER BY relationship.sort_order NULLS LAST,
              relationship.domain_category_id
     LIMIT 1`,
    [pathId]
  );
  const schedule = await pool.query<{ scheduler_job_id: string }>(
    `INSERT INTO scheduler_jobs (
       idempotency_key, workspace_id, created_by_user_id,
       starting_entity_path_id, category_selection_mode, prompt_depth,
       prompt_policy_version, job_name, schedule_expression,
       request_payload, next_run_at
     ) VALUES (
               $1, $2, $3, $4, 'selected', 'high',
               'geo-prompt-policy-v1', $5, 'interval:3600',
               '{"providerModels":[{"provider":"mock","model":"mock-standard"}]}',
               $6)
     RETURNING scheduler_job_id`,
    [
      `e2e-schedule-${suffix}`,
      owner.workspaceId,
      owner.userId,
      pathId,
      `E2E ${suffix}`,
      dueAt
    ]
  );
  assert.ok(category.rows[0]);
  await pool.query(
    `INSERT INTO scheduler_job_requested_categories (
       scheduler_job_id, category_id, ordinal
     ) VALUES ($1, $2, 0)`,
    [schedule.rows[0]!.scheduler_job_id, category.rows[0]!.category_id]
  );
}

class ControlledOpenAiAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;
  private readonly behaviors = new Map<
    string,
    "success" | "retry_failure" | "invalid"
  >();

  supportsModel(model: string) {
    return model === "gpt-4o-mini";
  }

  reset() {
    this.behaviors.clear();
  }

  set(
    domain: string,
    behavior: "success" | "retry_failure" | "invalid"
  ) {
    this.behaviors.set(domain, behavior);
  }

  async execute(request: ProviderExecutionRequest) {
    const behavior =
      [...this.behaviors.entries()].find(([domain]) =>
        request.promptText.includes(`website domain: ${domain}`)
      )?.[1] ?? "success";
    if (behavior === "retry_failure") {
      throw new ProviderExecutionError(
        "PROVIDER_UNAVAILABLE",
        "Controlled provider outage"
      );
    }
    if (behavior === "invalid") {
      throw new ProviderExecutionError(
        "PROVIDER_RESPONSE_INVALID",
        "Controlled malformed response",
        true,
        {
          rawResponse: { malformed: true },
          validationErrors: ["evidence must be an array"]
        }
      );
    }
    return {
      generatedContent: JSON.stringify(controlledResponse(request)),
      sanitizedProviderMetadata: { controlled: true },
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      finishReason: "stop",
      providerRequestId: `e2e-openai:${request.providerJobId}`,
      modelVersion: request.model,
      latencyMs: 1
    };
  }
}

function controlledResponse(request: ProviderExecutionRequest) {
  const envelope = {
    prompt_type: request.promptType,
    contract_version: request.responseContractVersion,
    evidence: [
      {
        claim: `OpenAI ${request.promptType} evidence`,
        source: "controlled-openai",
        confidence: 0.8
      }
    ],
    summary: "Controlled OpenAI response"
  };
  if (request.promptType === "domain_category_classification") {
    return {
      prompt_type: request.promptType,
      contract_version: request.responseContractVersion,
      matches: [],
      summary: envelope.summary
    };
  }
  const result =
    request.promptType === "visibility"
      ? {
          target_mentioned: true,
          mention_likelihood: 0.8,
          recommendation_likelihood: 0.7,
          competitive_prominence: 0.6,
          query_intents: [],
          strengths: [],
          visibility_gaps: [],
          confidence: 0.8
        }
      : request.promptType === "ranking"
        ? {
            requested_top_k:
              request.promptDepth === "weak"
                ? 5
                : request.promptDepth === "medium"
                  ? 10
                  : 20,
            found: true,
            rank_position: 1,
            ordered_candidates: [
              { rank: 1, name: request.exactTargetName }
            ],
            mention_count: 1,
            confidence: 0.8
          }
        : request.promptType === "competitor"
          ? {
              direct_competitors: [],
              indirect_competitors: [],
              target_differentiation: "Controlled differentiation",
              competitive_pressure: 0.5,
              confidence: 0.8
            }
          : request.promptType === "price_range"
            ? {
                applicability: "unknown",
                currency: null,
                minimum: null,
                maximum: null,
                pricing_basis: "No controlled pricing",
                uncertainty: "Controlled fixture",
                confidence: 0.2
              }
            : {
                pros: [],
                cons: [],
                best_fit_for: [],
                poor_fit_for: [],
                comparison_context: "Controlled context",
                confidence: 0.8
              };
  return { ...envelope, result };
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
