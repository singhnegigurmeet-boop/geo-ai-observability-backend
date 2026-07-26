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
import { promptTypePolicy } from "../../../src/modules/prompts/policies/prompt-policy.registry.js";
import { providerModelProfile } from "../../../src/modules/providers/registry/provider-model.registry.js";
import { ReportAggregationService } from "../../../src/modules/reports/services/report-aggregation.service.js";
import { ReportRepository } from "../../../src/modules/reports/repositories/report.repository.js";

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

      const completed = await scoring.process(fixture.results[1]!);
      assert.ok(completed.reportId);
      assert.equal(await count(pool, "provider_scores"), 2);
      assert.equal(await count(pool, "reports"), 2);

      const report = await reportFor(pool, fixture.analysisRunId);
      assert.equal(report.report_data.reportType, "multi_provider_report");
      assert.equal(report.report_data.breakdown.length, 2);
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
      assert.equal(await count(pool, "provider_scores"), 2);
      assert.equal(await count(pool, "reports"), 2);
    });

    it("reports five prompt results with two GEO scoring metrics", async () => {
      for (const actor of ["user", "claimed"] as const) {
        const fixture = await seedRun(pool, actor, richPrompts);
        const scoring = new ProviderScoreService(pool);
        assert.ok((await scoring.process(fixture.results[0]!)).reportId);
        assert.equal(
          Number(
            (
              await pool.query<{ count: string }>(
                "SELECT count(*) FROM reports WHERE analysis_run_id = $1",
                [fixture.analysisRunId]
              )
            ).rows[0]!.count
          ),
          1
        );
        const completed = await scoring.process(fixture.results[1]!);
        assert.ok(completed.reportId);
        const report = await reportFor(pool, fixture.analysisRunId);
        assert.equal(report.report_data.breakdown.length, 2);
        assert.equal(report.report_data.providerResults.length, 5);
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
        scoring_version: string;
        score_components: Record<string, unknown>;
      }>("SELECT score, scoring_version, score_components FROM provider_scores");
      assert.equal(score.rows[0]?.score, "64.0000");
      assert.equal(score.rows[0]?.scoring_version, "geo-scoring-v2");
    });

    it("uses the 60/40 model-path GEO score for provider/model averages", async () => {
      const fixture = await seedRun(
        pool,
        "anonymous",
        ["visibility", "ranking"],
        {
          visibilityLikelihood: 1,
          rankingFound: false
        }
      );
      const scoring = new ProviderScoreService(pool);
      for (const result of fixture.results) await scoring.process(result);
      const report = await reportFor(pool, fixture.analysisRunId);
      assert.equal(
        report.report_data.modelPathScores[0]?.geoScore,
        60
      );
      assert.equal(
        report.report_data.providerModelComparison[0]?.averageGeoScore,
        60
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

    it("terminalizes exhausted normal scoring as a final gap without changing valid evidence", async () => {
      const fixture = await seedRun(pool, "anonymous", lightPrompts, {
        rankingFound: false
      });
      const scoring = new ProviderScoreService(pool);
      await scoring.process(fixture.results[0]!);
      const rankingResultId = fixture.resultIdsByPrompt.get("ranking")!;
      const failure = scoringFailure(rankingResultId, "ranking-exhausted");
      const channel = await rabbitMq.getConfirmChannel();
      const runtime = new ProviderScoreWorkerRuntime(
        channel,
        {
          async process() {
            throw new Error("simulated score persistence failure");
          }
        },
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
          messageId: failure.messageId,
          eventType: "provider_result.created",
          aggregateType: "provider_result",
          aggregateId: rankingResultId,
          occurredAt: new Date().toISOString(),
          attempt: 1,
          payload: { providerResultId: rankingResultId }
        });
        await pollUntil(
          async () =>
            (await failureCountFor(
              pool,
              "provider_result",
              rankingResultId,
              "scoring_queue"
            )) === 3
        );
        const deadLetter = await pollMessage(
          channel,
          deadLetterQueueName("scoring_queue")
        );
        channel.ack(deadLetter);
      } finally {
        await runtime.stop();
      }

      const evidence = await pool.query<{
        status: string;
        context_validation_status: string;
        found: boolean;
        score: string | null;
      }>(
        `SELECT
           result.status,
           result.context_validation_status,
           (result.validated_response #>> '{result,found}')::boolean AS found,
           score.score
         FROM provider_results AS result
         LEFT JOIN provider_scores AS score
           ON score.provider_result_id = result.provider_result_id
         WHERE result.provider_result_id = $1`,
        [rankingResultId]
      );
      assert.deepEqual(evidence.rows, [{
        status: "valid",
        context_validation_status: "valid",
        found: false,
        score: null
      }]);
      const report = await terminalizationReport(
        pool,
        fixture.analysisRunId
      );
      assert.equal(report.lifecycleState, "completed_with_gaps");
      assert.equal(report.final, true);
      assert.equal(report.coverage.validScored, 1);
      assert.equal(report.coverage.validDiagnostic, 1);
      assert.equal(report.coverage.permanentScoringFailure, 1);
      assert.deepEqual(
        report.providerResults
          .filter((result) => result.promptType === "ranking")
          .map((result) => ({
            executionState: result.executionState,
            score: result.score
          })),
        [{ executionState: "permanent_scoring_failure", score: null }]
      );
      assert.equal(
        await failureCountFor(
          pool,
          "provider_result",
          rankingResultId,
          "scoring_queue"
        ),
        3
      );
      assert.equal(await reportCount(pool, fixture.analysisRunId), 2);

      await Promise.all([
        new FailureRecordRepository(pool).createAndTerminalize({
          ...failure,
          attemptNumber: 3
        }),
        new FailureRecordRepository(pool).createAndTerminalize({
          ...failure,
          attemptNumber: 3
        })
      ]);
      assert.equal(await reportCount(pool, fixture.analysisRunId), 2);
    });

    it("creates failed_empty when all score-bearing evidence exhausts and diagnostics are invalid", async () => {
      const fixture = await seedRun(pool, "anonymous", lightPrompts, {
        rankingFound: false,
        invalidPromptTypes: ["competitor"]
      });
      await new FailureRecordRepository(pool).createAndTerminalize(
        scoringFailure(
          fixture.resultIdsByPrompt.get("visibility")!,
          "visibility-exhausted"
        )
      );
      await new FailureRecordRepository(pool).createAndTerminalize(
        scoringFailure(
          fixture.resultIdsByPrompt.get("ranking")!,
          "ranking-exhausted"
        )
      );

      const report = await terminalizationReport(
        pool,
        fixture.analysisRunId
      );
      assert.equal(report.lifecycleState, "failed_empty");
      assert.equal(report.final, true);
      assert.equal(report.coverage.validScored, 0);
      assert.equal(report.coverage.permanentScoringFailure, 2);
      assert.equal(await count(pool, "provider_scores"), 0);
    });

    it("treats delayed diagnostic, invalid, and already-scored messages as idempotent scoring no-ops", async () => {
      const diagnostic = await seedRun(pool, "anonymous", lightPrompts);
      const scoring = new ProviderScoreService(pool);
      const diagnosticOutcome = await scoring.process({
        providerResultId:
          diagnostic.resultIdsByPrompt.get("competitor")!
      });
      assert.equal(diagnosticOutcome.outcome, "noop");
      assert.equal(diagnosticOutcome.providerScoreId, null);

      const invalid = await seedRun(pool, "anonymous", ["visibility"], {
        invalidPromptTypes: ["visibility"]
      });
      const invalidOutcome = await scoring.process(invalid.results[0]!);
      assert.equal(invalidOutcome.outcome, "noop");
      assert.equal(invalidOutcome.providerScoreId, null);

      const scored = await seedRun(pool, "anonymous", ["visibility"]);
      const first = await scoring.process(scored.results[0]!);
      const replay = await scoring.process(scored.results[0]!);
      assert.equal(first.outcome, "scored");
      assert.equal(replay.outcome, "noop");
      assert.equal(replay.providerScoreId, first.providerScoreId);
      assert.equal(
        Number(
          (
            await pool.query<{ count: string }>(
              "SELECT count(*) FROM failure_records"
            )
          ).rows[0]!.count
        ),
        0
      );
    });

    it("finalizes direct analysis-run exhaustion and preserves delayed terminal outcomes", async () => {
      const failed = await seedExactCoverageRun(pool, {
        zeroProviderJobs: true,
        runStatus: "processing"
      });
      const runFailure = {
        queueName: "analysis_run_queue",
        messageId: `analysis-run-exhausted:${failed.analysisRunId}`,
        aggregateType: "analysis_run",
        aggregateId: failed.analysisRunId,
        attemptNumber: 3,
        errorCode: "ANALYSIS_EXPANSION_FAILED",
        errorMessage: "internal database details must not be public"
      };
      await new FailureRecordRepository(pool).createAndTerminalize(runFailure);
      const failedReport = await terminalizationReport(
        pool,
        failed.analysisRunId
      );
      assert.equal(failedReport.runStatus, "failed");
      assert.equal(failedReport.lifecycleState, "failed_empty");
      assert.equal(failedReport.final, true);
      assert.equal(failedReport.coverage.expectedProviderJobs, 12);
      assert.equal(failedReport.coverage.missingBeforeFanOut, 12);
      assert.equal(await reportCount(pool, failed.analysisRunId), 1);
      await new FailureRecordRepository(pool).createAndTerminalize(runFailure);
      assert.equal(await runStatus(pool, failed.analysisRunId), "failed");
      assert.equal(await reportCount(pool, failed.analysisRunId), 1);

      await pool.query(
        `UPDATE analysis_runs
         SET status = 'cancelled', completed_at = now(),
             error_code = NULL, error_message = NULL
         WHERE analysis_run_id = $1`,
        [failed.analysisRunId]
      );
      await new FailureRecordRepository(pool).createAndTerminalize({
        queueName: "analysis_run_queue",
        messageId: `analysis-run-delayed:${failed.analysisRunId}`,
        aggregateType: "analysis_run",
        aggregateId: failed.analysisRunId,
        attemptNumber: 3,
        errorCode: "DELAYED_FAILURE",
        errorMessage: "delayed failure"
      });
      assert.equal(await runStatus(pool, failed.analysisRunId), "cancelled");

      const emptyRunId = await seedNoMatchingCategoryRun(pool);
      await pool.query(
        `UPDATE analysis_runs
         SET status = 'processing', completed_at = NULL
         WHERE analysis_run_id = $1`,
        [emptyRunId]
      );
      await new FailureRecordRepository(pool).createAndTerminalize({
        queueName: "analysis_run_queue",
        messageId: `analysis-run-empty-delayed:${emptyRunId}`,
        aggregateType: "analysis_run",
        aggregateId: emptyRunId,
        attemptNumber: 3,
        errorCode: "DELAYED_FAILURE",
        errorMessage: "delayed failure"
      });
      const emptyReport = await terminalizationReport(pool, emptyRunId);
      assert.equal(emptyReport.runStatus, "completed");
      assert.equal(emptyReport.lifecycleState, "completed_empty");
    });

    it("retains exact missing-before-fan-out coverage after prompt exhaustion", async () => {
      const fixture = await seedExactCoverageRun(pool, {
        zeroProviderJobs: true,
        runStatus: "processing"
      });
      const prompt = await pool.query<{
        prompt_job_id: string;
        llm_run_id: string;
        analysis_run_item_id: string;
      }>(
        `SELECT prompt.prompt_job_id, llm.llm_run_id,
                item.analysis_run_item_id
         FROM prompt_jobs AS prompt
         JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
         JOIN analysis_run_items AS item
           ON item.analysis_run_item_id = llm.analysis_run_item_id
         WHERE item.analysis_run_id = $1
         ORDER BY item.item_ordinal, prompt.prompt_job_id
         LIMIT 1`,
        [fixture.analysisRunId]
      );
      const target = prompt.rows[0]!;
      await pool.query(
        `UPDATE prompt_jobs
         SET status = 'processing', completed_at = NULL
         WHERE prompt_job_id = $1`,
        [target.prompt_job_id]
      );
      await pool.query(
        `UPDATE llm_runs SET status = 'processing', completed_at = NULL
         WHERE llm_run_id = $1`,
        [target.llm_run_id]
      );
      await pool.query(
        `UPDATE analysis_run_items
         SET status = 'processing', completed_at = NULL
         WHERE analysis_run_item_id = $1`,
        [target.analysis_run_item_id]
      );
      await new FailureRecordRepository(pool).createAndTerminalize({
        queueName: "visibility_prompt_queue",
        messageId: `prompt-exhausted:${target.prompt_job_id}`,
        aggregateType: "prompt_job",
        aggregateId: target.prompt_job_id,
        attemptNumber: 3,
        errorCode: "PROMPT_RENDER_FAILED",
        errorMessage: "internal rendering details"
      });

      const report = await terminalizationReport(
        pool,
        fixture.analysisRunId
      );
      assert.equal(report.lifecycleState, "failed_empty");
      assert.equal(report.final, true);
      assert.equal(report.coverage.expectedProviderJobs, 12);
      assert.equal(report.coverage.missingBeforeFanOut, 12);
      assert.ok(
        report.missingExpectedExecutions.executions.every(
          (execution) => execution.missingStage === "provider_job"
        )
      );
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
      assert.equal(notifications.rows.length, 2);
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

    it("reconciles 2 category items × 3 prompts × 2 models as 12 complete executions", async () => {
      const fixture = await seedExactCoverageRun(pool);
      const outcome = await aggregateExactCoverage(
        pool,
        fixture.analysisRunId
      );
      assert.equal(outcome.lifecycleState, "completed");
      const report = await exactCoverageReport(pool, fixture.analysisRunId);
      assert.equal(report.coverage.expectedProviderJobs, 12);
      assert.equal(report.coverage.materializedProviderJobs, 12);
      assert.equal(report.coverage.validScored, 8);
      assert.equal(report.coverage.validDiagnostic, 4);
      assert.equal(report.final, true);
    });

    it("keeps one terminal missing-before-fan-out tuple visible and final", async () => {
      const fixture = await seedExactCoverageRun(pool, {
        omit: {
          itemIndex: 1,
          promptType: "ranking",
          model: "mock-quality"
        }
      });
      const first = await aggregateExactCoverage(pool, fixture.analysisRunId);
      assert.equal(first.lifecycleState, "completed_with_gaps");
      const second = await aggregateExactCoverage(pool, fixture.analysisRunId);
      assert.equal(second.created, false);
      const report = await exactCoverageReport(pool, fixture.analysisRunId);
      assert.equal(report.coverage.expectedProviderJobs, 12);
      assert.equal(report.coverage.materializedProviderJobs, 11);
      assert.equal(report.coverage.missingBeforeFanOut, 1);
      assert.equal(report.final, true);
      assert.deepEqual(report.missingExpectedExecutions.executions, [
        {
          analysisRunItemId: fixture.itemIds[1],
          entityPathId: fixture.pathIds[1],
          categoryId: fixture.categoryIds[1],
          promptType: "ranking",
          provider: "mock",
          model: "mock-quality",
          missingStage: "provider_job",
          reason: "expected_but_not_materialized"
        }
      ]);
      assert.equal(await reportCount(pool, fixture.analysisRunId), 1);
    });

    it("retains a selected model with no materialized provider jobs", async () => {
      const fixture = await seedExactCoverageRun(pool, {
        onlyModel: "mock-standard"
      });
      await aggregateExactCoverage(pool, fixture.analysisRunId);
      const report = await exactCoverageReport(pool, fixture.analysisRunId);
      const missingModel = report.providerModelComparison.find(
        (entry) => entry.model === "mock-quality"
      );
      assert.ok(missingModel);
      assert.equal(missingModel.expectedExecutions, 6);
      assert.equal(missingModel.materializedExecutions, 0);
      assert.equal(missingModel.missingBeforeFanOut, 6);
    });

    it("treats valid competitor diagnostics as terminal without scores", async () => {
      const fixture = await seedExactCoverageRun(pool);
      await aggregateExactCoverage(pool, fixture.analysisRunId);
      const report = await exactCoverageReport(pool, fixture.analysisRunId);
      assert.equal(report.coverage.validDiagnostic, 4);
      assert.equal(report.coverage.pending, 0);
      assert.equal(report.lifecycleState, "completed");
    });

    it("classifies failed expected work with zero provider jobs as failed_empty", async () => {
      const fixture = await seedExactCoverageRun(pool, {
        zeroProviderJobs: true,
        runStatus: "failed"
      });
      const outcome = await aggregateExactCoverage(
        pool,
        fixture.analysisRunId
      );
      assert.equal(outcome.lifecycleState, "failed_empty");
      const report = await exactCoverageReport(pool, fixture.analysisRunId);
      assert.equal(report.coverage.expectedProviderJobs, 12);
      assert.equal(report.coverage.materializedProviderJobs, 0);
      assert.equal(report.lifecycleState, "failed_empty");
    });

    it("preserves no_matching_category as completed_empty with zero expected work", async () => {
      const analysisRunId = await seedNoMatchingCategoryRun(pool);
      const outcome = await aggregateExactCoverage(pool, analysisRunId);
      assert.equal(outcome.lifecycleState, "completed_empty");
      const report = await exactCoverageReport(pool, analysisRunId);
      assert.equal(report.coverage.expectedProviderJobs, 0);
      assert.equal(report.lifecycleState, "completed_empty");
    });
  }
);

type Actor = "anonymous" | "user" | "claimed";

async function seedRun(
  pool: pg.Pool,
  actor: Actor,
  promptTypes: PromptType[],
  evidence: {
    providerScore?: number;
    confidence?: number;
    rankingFound?: boolean;
    visibilityLikelihood?: number;
    invalidPromptTypes?: readonly PromptType[];
  } = {}
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
  const categoryId = (
    await pool.query<{ category_id: string }>(
      `INSERT INTO categories (category_name, normalized_name)
       VALUES ($1, $2) RETURNING category_id`,
      [`Reporting category ${unique}`, `reporting-${unique}`]
    )
  ).rows[0]!.category_id;
  const domainCategoryId = (
    await pool.query<{ domain_category_id: string }>(
      `INSERT INTO domain_categories (domain_id, category_id)
       VALUES ($1, $2) RETURNING domain_category_id`,
      [domainId, categoryId]
    )
  ).rows[0]!.domain_category_id;
  const deepPath = promptTypes.some(
    (promptType) =>
      promptType === "price_range" || promptType === "pros_cons"
  );
  let brandId: string | null = null;
  let productId: string | null = null;
  if (deepPath) {
    brandId = (
      await pool.query<{ brand_id: string }>(
        `INSERT INTO brands (brand_name, normalized_name)
         VALUES ($1, $2) RETURNING brand_id`,
        [`Reporting brand ${unique}`, `reporting-brand-${unique}`]
      )
    ).rows[0]!.brand_id;
    const categoryBrandId = (
      await pool.query<{ category_brand_id: string }>(
        `INSERT INTO category_brands (domain_category_id, brand_id)
         VALUES ($1, $2) RETURNING category_brand_id`,
        [domainCategoryId, brandId]
      )
    ).rows[0]!.category_brand_id;
    productId = (
      await pool.query<{ product_id: string }>(
        `INSERT INTO products (product_name, normalized_name)
         VALUES ($1, $2) RETURNING product_id`,
        [`Reporting product ${unique}`, `reporting-product-${unique}`]
      )
    ).rows[0]!.product_id;
    await pool.query(
      `INSERT INTO brand_products (category_brand_id, product_id)
       VALUES ($1, $2)`,
      [categoryBrandId, productId]
    );
  }
  const pathId = (
    await pool.query<{ entity_path_id: string }>(
      `
        INSERT INTO entity_paths (
          domain_id, category_id, brand_id, product_id, path_type
        )
        VALUES (
          $1, $2, $3, $4,
          CASE WHEN $4::bigint IS NULL
            THEN 'category'::entity_path_type
            ELSE 'product'::entity_path_type
          END
        )
        RETURNING entity_path_id
      `,
      [domainId, categoryId, brandId, productId]
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
          $1, $2, $3, $4, $5, 'selected', $6, 'geo-prompt-policy-v1',
          'processing', jsonb_build_object('domain', $7::text), now()
        )
        RETURNING analysis_run_id
      `,
      [
        `reporting-run:${unique}`,
        anonymousSessionId,
        userId,
        workspaceId,
        pathId,
        actor === "anonymous" ? "weak" : "high",
        `reporting-${unique}.example`
      ]
    )
  ).rows[0]!.analysis_run_id;
  await pool.query(
    `INSERT INTO analysis_run_requested_categories (
       analysis_run_id, category_id, ordinal
     ) VALUES ($1, $2, 0)`,
    [analysisRunId, categoryId]
  );
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
  const resultIdsByPrompt = new Map<PromptType, string>();
  for (const promptType of promptTypes) {
    const promptPolicy = promptTypePolicy(promptType);
    const promptDepth = actor === "anonymous" ? "weak" : "high";
    const promptJobId = (
      await pool.query<{ prompt_job_id: string }>(
        `
          INSERT INTO prompt_jobs (
            idempotency_key, llm_run_id, prompt_type, prompt_depth,
            business_prompt_version, response_contract_version,
            status, prompt_text, started_at, completed_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, 'succeeded', $7, now(), now()
          )
          RETURNING prompt_job_id
        `,
        [
          `reporting-prompt:${unique}:${promptType}`,
          llmRunId,
          promptType,
          promptDepth,
          promptPolicy.businessPromptVersion,
          promptPolicy.responseContractVersion,
          `Canonical ${promptType} prompt`
        ]
      )
    ).rows[0]!.prompt_job_id;
    const providerJobId = (
      await pool.query<{ provider_job_id: string }>(
        `
          INSERT INTO provider_jobs (
            idempotency_key, job_kind, prompt_job_id, provider, model,
            response_contract_version, provider_instruction_profile,
            model_profile_version, structured_output_mode, status,
            started_at, completed_at
          )
          VALUES (
            $1, 'normal_prompt', $2, 'mock', $3, $4,
            'mock-json-schema-v1', $5, 'json_schema',
            'succeeded', now(), now()
          )
          RETURNING provider_job_id
        `,
        [
          `reporting-provider:${unique}:${promptType}`,
          promptJobId,
          model,
          promptPolicy.responseContractVersion,
          modelProfile.modelProfileVersion
        ]
      )
    ).rows[0]!.provider_job_id;
    const validatedResponse = {
      prompt_type: promptType,
      contract_version: promptPolicy.responseContractVersion,
      result:
        promptType === "visibility"
          ? {
              target_mentioned: true,
              mention_likelihood: evidence.visibilityLikelihood ?? 0.6,
              recommendation_likelihood:
                evidence.visibilityLikelihood ?? 0.6,
              competitive_prominence:
                evidence.visibilityLikelihood ?? 0.8,
              query_intents: [],
              strengths: [],
              visibility_gaps: [],
              confidence: evidence.confidence ?? 0.75
            }
          : promptType === "ranking"
            ? {
                requested_top_k: promptDepth === "weak" ? 5 : 20,
                found: evidence.rankingFound ?? true,
                rank_position:
                  evidence.rankingFound === false ? null : 1,
                ordered_candidates:
                  evidence.rankingFound === false
                    ? []
                    : [
                        {
                          rank: 1,
                          name: `Reporting category ${unique}`
                        }
                      ],
                mention_count: evidence.rankingFound === false ? 0 : 1,
                confidence: evidence.confidence ?? 0.75
              }
            : { confidence: evidence.confidence ?? 0.75 },
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
            response_contract_version, provider_request_id, model_version,
            raw_response, raw_response_original_bytes, provider_metadata,
            validated_response, validation_errors, context_validation_status,
            finish_reason, latency_ms, received_at
          )
          VALUES (
            $1, $2, 'mock', $8, $3, $4, $5, $6,
            octet_length($6), '{}'::jsonb, $7, $9, $10,
            'mock_complete', 0, now()
          )
          RETURNING provider_result_id
        `,
        [
          `reporting-result:${unique}:${promptType}`,
          providerJobId,
          promptPolicy.responseContractVersion,
          `reporting-request:${unique}:${promptType}`,
          model,
          JSON.stringify(validatedResponse),
          evidence.invalidPromptTypes?.includes(promptType)
            ? null
            : validatedResponse,
          evidence.invalidPromptTypes?.includes(promptType)
            ? "invalid"
            : "valid",
          evidence.invalidPromptTypes?.includes(promptType)
            ? JSON.stringify([{ code: "TEST_INVALID_EVIDENCE" }])
            : JSON.stringify([]),
          evidence.invalidPromptTypes?.includes(promptType)
            ? "invalid"
            : "valid"
        ]
      )
    ).rows[0]!.provider_result_id;
    resultIdsByPrompt.set(promptType, providerResultId);
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
    if (promptType === "visibility" || promptType === "ranking") {
      results.push({ providerResultId });
    }
  }
  return {
    analysisRunId,
    anonymousSessionId,
    userId,
    workspaceId,
    results,
    resultIdsByPrompt
  };
}

async function seedExactCoverageRun(
  pool: pg.Pool,
  options: {
    omit?: {
      itemIndex: number;
      promptType: PromptType;
      model: string;
    };
    onlyModel?: string;
    zeroProviderJobs?: boolean;
    runStatus?: "processing" | "completed" | "failed";
  } = {}
) {
  const unique = crypto.randomUUID();
  const anonymousSessionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO anonymous_sessions (token_hash, expires_at)
       VALUES ($1, now() + interval '1 day')
       RETURNING anonymous_session_id AS id`,
      [`exact-coverage-token:${unique}`]
    )
  ).rows[0]!.id;
  const domainId = (
    await pool.query<{ id: string }>(
      `INSERT INTO domains (normalized_domain)
       VALUES ($1) RETURNING domain_id AS id`,
      [`exact-coverage-${unique}.example`]
    )
  ).rows[0]!.id;
  const categoryIds: string[] = [];
  const pathIds: string[] = [];
  for (const index of [0, 1]) {
    const categoryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO categories (category_name, normalized_name)
         VALUES ($1, $2) RETURNING category_id AS id`,
        [`Exact category ${index}`, `exact-${index}-${unique}`]
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO domain_categories (domain_id, category_id)
       VALUES ($1, $2)`,
      [domainId, categoryId]
    );
    const pathId = (
      await pool.query<{ id: string }>(
        `INSERT INTO entity_paths (domain_id, category_id, path_type)
         VALUES ($1, $2, 'category') RETURNING entity_path_id AS id`,
        [domainId, categoryId]
      )
    ).rows[0]!.id;
    categoryIds.push(categoryId);
    pathIds.push(pathId);
  }
  const runStatus = options.runStatus ?? "completed";
  const analysisRunId = (
    await pool.query<{ id: string }>(
      `
        INSERT INTO analysis_runs (
          idempotency_key, anonymous_session_id, starting_entity_path_id,
          category_selection_mode, prompt_depth, prompt_policy_version,
          status, request_payload, started_at, completed_at
        )
        VALUES (
          $1, $2, $3, 'selected', 'medium', 'geo-prompt-policy-v1',
          $4, jsonb_build_object('domain', $5::text), now(),
          CASE
            WHEN $4::analysis_execution_status IN (
              'completed', 'partial_success', 'failed', 'cancelled'
            )
            THEN now()
            ELSE NULL
          END
        )
        RETURNING analysis_run_id AS id
      `,
      [
        `exact-coverage-run:${unique}`,
        anonymousSessionId,
        pathIds[0],
        runStatus,
        `exact-coverage-${unique}.example`
      ]
    )
  ).rows[0]!.id;
  const frozenModels = ["mock-standard", "mock-quality"] as const;
  for (const [ordinal, model] of frozenModels.entries()) {
    const profile = providerModelProfile("mock", model);
    assert.ok(profile);
    await pool.query(
      `INSERT INTO analysis_run_provider_models (
         analysis_run_id, provider, model, model_profile_version, ordinal
       ) VALUES ($1, 'mock', $2, $3, $4)`,
      [analysisRunId, model, profile.modelProfileVersion, ordinal]
    );
  }
  const itemIds: string[] = [];
  for (const [itemIndex, pathId] of pathIds.entries()) {
    const itemId = (
      await pool.query<{ id: string }>(
        `INSERT INTO analysis_run_items (
           idempotency_key, analysis_run_id, entity_path_id, item_ordinal,
           status, started_at, completed_at
         ) VALUES ($1, $2, $3, $4, 'completed', now(), now())
         RETURNING analysis_run_item_id AS id`,
        [
          `exact-coverage-item:${unique}:${itemIndex}`,
          analysisRunId,
          pathId,
          itemIndex
        ]
      )
    ).rows[0]!.id;
    itemIds.push(itemId);
    const llmRunId = (
      await pool.query<{ id: string }>(
        `INSERT INTO llm_runs (
           idempotency_key, analysis_run_item_id, status,
           started_at, completed_at
         ) VALUES ($1, $2, 'completed', now(), now())
         RETURNING llm_run_id AS id`,
        [`exact-coverage-llm:${unique}:${itemIndex}`, itemId]
      )
    ).rows[0]!.id;
    for (const promptType of lightPrompts) {
      const policy = promptTypePolicy(promptType);
      const promptJobId = (
        await pool.query<{ id: string }>(
          `INSERT INTO prompt_jobs (
             idempotency_key, llm_run_id, prompt_type, prompt_depth,
             business_prompt_version, response_contract_version,
             status, prompt_text, started_at, completed_at
           ) VALUES (
             $1, $2, $3, 'medium', $4, $5,
             'succeeded', $6, now(), now()
           ) RETURNING prompt_job_id AS id`,
          [
            `exact-coverage-prompt:${unique}:${itemIndex}:${promptType}`,
            llmRunId,
            promptType,
            policy.businessPromptVersion,
            policy.responseContractVersion,
            `Exact ${promptType} prompt`
          ]
        )
      ).rows[0]!.id;
      for (const model of frozenModels) {
        const omitted =
          options.zeroProviderJobs === true ||
          (options.onlyModel !== undefined && options.onlyModel !== model) ||
          (options.omit?.itemIndex === itemIndex &&
            options.omit.promptType === promptType &&
            options.omit.model === model);
        if (omitted) continue;
        const profile = providerModelProfile("mock", model);
        assert.ok(profile);
        const providerJobId = (
          await pool.query<{ id: string }>(
            `INSERT INTO provider_jobs (
               idempotency_key, job_kind, prompt_job_id, provider, model,
               response_contract_version, provider_instruction_profile,
               model_profile_version, structured_output_mode, status,
               started_at, completed_at
             ) VALUES (
               $1, 'normal_prompt', $2, 'mock', $3, $4,
               'mock-json-schema-v1', $5, 'json_schema',
               'succeeded', now(), now()
             ) RETURNING provider_job_id AS id`,
            [
              `exact-coverage-provider:${unique}:${itemIndex}:${promptType}:${model}`,
              promptJobId,
              model,
              policy.responseContractVersion,
              profile.modelProfileVersion
            ]
          )
        ).rows[0]!.id;
        const response = {
          prompt_type: promptType,
          contract_version: policy.responseContractVersion,
          result: { confidence: 0.75 },
          evidence: [],
          summary: "Exact coverage evidence"
        };
        const rawResponse = JSON.stringify(response);
        const providerResultId = (
          await pool.query<{ id: string }>(
            `INSERT INTO provider_results (
               idempotency_key, provider_job_id, provider, status,
               response_contract_version, model_version, raw_response,
               raw_response_original_bytes, validated_response,
               validation_errors, context_validation_status,
               latency_ms, received_at
             ) VALUES (
               $1, $2, 'mock', 'valid', $3, $4, $5,
               octet_length($5), $6, '[]'::jsonb, 'valid', 0, now()
             ) RETURNING provider_result_id AS id`,
            [
              `exact-coverage-result:${unique}:${itemIndex}:${promptType}:${model}`,
              providerJobId,
              policy.responseContractVersion,
              model,
              rawResponse,
              response
            ]
          )
        ).rows[0]!.id;
        if (policy.requiresScoring) {
          await pool.query(
            `INSERT INTO provider_scores (
               idempotency_key, provider_result_id, metric_type,
               scoring_version, score, score_components
             ) VALUES ($1, $2, $3, 'geo-scoring-v2', 80, '{}'::jsonb)`,
            [
              `exact-coverage-score:${unique}:${itemIndex}:${promptType}:${model}`,
              providerResultId,
              promptType
            ]
          );
        }
      }
    }
  }
  return {
    analysisRunId,
    itemIds,
    pathIds,
    categoryIds
  };
}

async function seedNoMatchingCategoryRun(pool: pg.Pool) {
  const unique = crypto.randomUUID();
  const sessionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO anonymous_sessions (token_hash, expires_at)
       VALUES ($1, now() + interval '1 day')
       RETURNING anonymous_session_id AS id`,
      [`empty-token:${unique}`]
    )
  ).rows[0]!.id;
  const domainId = (
    await pool.query<{ id: string }>(
      `INSERT INTO domains (normalized_domain)
       VALUES ($1) RETURNING domain_id AS id`,
      [`empty-${unique}.example`]
    )
  ).rows[0]!.id;
  const pathId = (
    await pool.query<{ id: string }>(
      `INSERT INTO entity_paths (domain_id, path_type)
       VALUES ($1, 'domain') RETURNING entity_path_id AS id`,
      [domainId]
    )
  ).rows[0]!.id;
  const analysisRunId = (
    await pool.query<{ id: string }>(
      `INSERT INTO analysis_runs (
         idempotency_key, anonymous_session_id, starting_entity_path_id,
         category_selection_mode, prompt_depth, prompt_policy_version,
         status, request_payload, started_at, completed_at
       ) VALUES (
         $1, $2, $3, 'all', 'weak', 'geo-prompt-policy-v1',
         'completed', '{}'::jsonb, now(), now()
       ) RETURNING analysis_run_id AS id`,
      [`empty-run:${unique}`, sessionId, pathId]
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO domain_category_classification_jobs (
       idempotency_key, analysis_run_id, domain_id, candidate_set_hash,
       status, classifier_provider, classifier_model, model_profile_version,
       prompt_version, response_contract_version,
       provider_instruction_profile, structured_output_mode, input_payload,
       rendered_prompt, candidate_count, started_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, 'completed_empty', 'mock', 'mock-fast',
       'mock-profile-v1', 'classification-v1',
       'classification-response-v1', 'mock-json-schema-v1',
       'json_schema', '{}'::jsonb, 'Rendered classification', 1,
       now(), now()
     )`,
    [
      `empty-classification:${unique}`,
      analysisRunId,
      domainId,
      "0".repeat(64)
    ]
  );
  return analysisRunId;
}

async function aggregateExactCoverage(
  pool: pg.Pool,
  analysisRunId: string
) {
  const outcome = await new ReportAggregationService(
    new ReportRepository(pool)
  ).createIfReady(analysisRunId);
  assert.equal(outcome.outcome, "snapshot");
  return outcome;
}

async function exactCoverageReport(pool: pg.Pool, analysisRunId: string) {
  return (
    await pool.query<{
      report_data: {
        lifecycleState: string;
        final: boolean;
        coverage: {
          expectedProviderJobs: number;
          materializedProviderJobs: number;
          validScored: number;
          validDiagnostic: number;
          missingBeforeFanOut: number;
          pending: number;
        };
        missingExpectedExecutions: {
          executions: Array<{
            analysisRunItemId: string;
            entityPathId: string;
            categoryId: string | null;
            promptType: string;
            provider: string;
            model: string;
            missingStage: string;
            reason: string;
          }>;
        };
        providerModelComparison: Array<{
          model: string;
          expectedExecutions: number;
          materializedExecutions: number;
          missingBeforeFanOut: number;
        }>;
      };
    }>(
      `SELECT report_data
       FROM reports
       WHERE analysis_run_id = $1
       ORDER BY revision DESC
       LIMIT 1`,
      [analysisRunId]
    )
  ).rows[0]!.report_data;
}

function scoringFailure(providerResultId: string, messageId: string) {
  return {
    queueName: "scoring_queue",
    messageId,
    aggregateType: "provider_result",
    aggregateId: providerResultId,
    attemptNumber: 3,
    errorCode: "SCORING_PERSISTENCE_FAILED",
    errorMessage: "internal score persistence details"
  };
}

async function terminalizationReport(
  pool: pg.Pool,
  analysisRunId: string
) {
  const row = (
    await pool.query<{
      run_status: string;
      report_data: {
        lifecycleState: string;
        final: boolean;
        coverage: {
          expectedProviderJobs: number;
          validScored: number;
          validDiagnostic: number;
          permanentScoringFailure: number;
          missingBeforeFanOut: number;
        };
        providerResults: Array<{
          promptType: PromptType;
          executionState: string;
          score: number | null;
        }>;
        missingExpectedExecutions: {
          executions: Array<{ missingStage: string }>;
        };
      };
    }>(
      `SELECT run.status AS run_status, report.report_data
       FROM reports AS report
       JOIN analysis_runs AS run
         ON run.analysis_run_id = report.analysis_run_id
       WHERE report.analysis_run_id = $1
       ORDER BY report.revision DESC
       LIMIT 1`,
      [analysisRunId]
    )
  ).rows[0]!;
  return {
    runStatus: row.run_status,
    ...row.report_data
  };
}

async function failureCountFor(
  pool: pg.Pool,
  aggregateType: string,
  aggregateId: string,
  queueName: string
) {
  return Number(
    (
      await pool.query<{ count: string }>(
        `SELECT count(*) FROM failure_records
         WHERE aggregate_type = $1
           AND aggregate_id = $2
           AND queue_name = $3`,
        [aggregateType, aggregateId, queueName]
      )
    ).rows[0]!.count
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

async function reportCount(pool: pg.Pool, analysisRunId: string) {
  return Number(
    (
      await pool.query<{ count: string }>(
        "SELECT count(*) FROM reports WHERE analysis_run_id = $1",
        [analysisRunId]
      )
    ).rows[0]!.count
  );
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
        modelPathScores: Array<{ geoScore: number | null }>;
        providerModelComparison: Array<{
          averageGeoScore: number | null;
        }>;
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
        messageId: value.messageId,
        headers: {
          ...(typeof value.aggregateType === "string"
            ? { aggregateType: value.aggregateType }
            : {}),
          ...(typeof value.aggregateId === "string"
            ? { aggregateId: value.aggregateId }
            : {})
        }
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
