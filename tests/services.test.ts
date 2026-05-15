import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SQL_QUERIES } from "../src/db/sql-queries.js";
import { DiffEngineService } from "../src/modules/diffs/services/diff-engine.service.js";
import { NotificationService } from "../src/modules/notifications/services/notification.service.js";
import { DomainSchedulerService } from "../src/modules/scheduler/services/domain-scheduler.service.js";
import type { AnalysisDiffRow, ProviderSnapshotRow } from "../src/types/database.types.js";

const now = new Date("2026-05-15T12:00:00.000Z");

describe("focused services", () => {
  it("scheduler enqueues due schedules and indexes the scheduled run event", async () => {
    const queueJobs: unknown[] = [];
    const indexed: unknown[] = [];
    const service = new DomainSchedulerService({
      domainSchedulesRepository: {
        async findDueSchedules() {
          return [
            {
              id: 3,
              domain_id: 9,
              domain: "nike.com",
              cadence: "weekly",
              enabled: true,
              last_enqueued_at: null,
              next_run_at: now,
              created_at: now,
              updated_at: now
            }
          ];
        },
        async markEnqueued() {
          return {
            id: 3,
            domain_id: 9,
            domain: "nike.com",
            cadence: "weekly",
            enabled: true,
            last_enqueued_at: now,
            next_run_at: new Date("2026-05-22T12:00:00.000Z"),
            created_at: now,
            updated_at: now
          };
        }
      } as any,
      analysisRunsRepository: {
        async createQueuedRun() {
          return { id: 42, domain_id: 9 };
        },
        async attachBullMqJob() {
          return {};
        }
      } as any,
      analysisQueue: {
        async add(_name: string, data: unknown, options: unknown) {
          queueJobs.push({ data, options });
          return { id: "analysis-run-42-test" };
        }
      } as any,
      observabilityIndexService: {
        async indexScheduledRun(document: unknown) {
          indexed.push(document);
        }
      } as any
    });

    const result = await service.enqueueDueDomains();

    assert.equal(result.length, 1);
    assert.equal(result[0].analysisRunId, 42);
    assert.equal(queueJobs.length, 1);
    assert.equal(indexed.length, 1);
    assert.equal((indexed[0] as { event: string }).event, "scheduled_run_enqueued");
  });

  it("notification service queues and marks log notifications sent", async () => {
    const queueJobs: unknown[] = [];
    const indexed: Array<{ event: string }> = [];
    const notification = {
      id: 5,
      domain_id: 1,
      analysis_diff_id: 8,
      channel: "log",
      status: "pending",
      payload: { diff_type: "visibility_score_dropped" },
      error_message: null,
      created_at: now,
      sent_at: null
    };
    const service = new NotificationService({
      notificationsRepository: {
        async insertNotification() {
          return notification;
        },
        async findById() {
          return notification;
        },
        async markSent() {
          return { ...notification, status: "sent", sent_at: now };
        },
        async markFailed() {
          throw new Error("markFailed should not be called");
        }
      } as any,
      notificationQueue: {
        async add(_name: string, data: unknown) {
          queueJobs.push(data);
        }
      } as any,
      observabilityIndexService: {
        async indexNotification(document: { event: string }) {
          indexed.push(document);
        }
      } as any
    });

    const diff = {
      id: 8,
      domain_id: 1,
      analysis_run_id: 2,
      previous_analysis_run_id: 1,
      diff_type: "visibility_score_dropped",
      provider: null,
      old_value: { overall_geo_score: 80 },
      new_value: { overall_geo_score: 60 },
      severity: "critical",
      created_at: now
    } as AnalysisDiffRow;

    const jobs = await service.enqueueDiffNotifications([diff]);
    await service.sendNotification(5);

    assert.deepEqual(jobs, [{ notificationId: 5, diffId: 8 }]);
    assert.deepEqual(queueJobs, [{ notificationId: 5 }]);
    assert.deepEqual(indexed.map((document) => document.event), ["notification_queued", "notification_sent"]);
  });

  it("diff engine stores score drop and provider recovery diffs", async () => {
    const inserted: unknown[] = [];
    const snapshot = (
      analysisRunId: number,
      llmName: "openai" | "gemini" | "claude",
      score: string,
      rankPosition: number | null,
      mentionCount: number
    ) =>
      ({
        id: analysisRunId * 100,
        domain_id: 1,
        analysis_run_id: analysisRunId,
        llm_name: llmName,
        top_k: 50,
        rank_position: rankPosition,
        mention_count: mentionCount,
        score,
        status: "completed",
        error_message: null,
        created_at: now
      }) as ProviderSnapshotRow;
    const service = new DiffEngineService({
      analysisRunsRepository: {
        async findPreviousSuccessfulRun() {
          return { id: 1 };
        }
      } as any,
      visibilityScoresRepository: {
        async findVisibilityScoreByRunId(analysisRunId: number) {
          return { overall_geo_score: analysisRunId === 2 ? 70 : 90 };
        }
      } as any,
      providerSnapshotsRepository: {
        async findProviderSnapshotsByRunId(analysisRunId: number) {
          return analysisRunId === 2
            ? [snapshot(2, "openai", "50.00", 20, 1)]
            : [snapshot(1, "openai", "0.00", null, 0)];
        }
      } as any,
      analysisDiffsRepository: {
        async insertAnalysisDiff(input: unknown) {
          inserted.push(input);
          return { id: inserted.length, ...(input as object) };
        }
      } as any
    });

    await service.calculateAndStoreDiffs(1, 2);

    assert.deepEqual(
      inserted.map((diff) => (diff as { diffType: string }).diffType),
      ["visibility_score_dropped", "provider_recovered"]
    );
  });
});

describe("SQL query registry", () => {
  it("keeps application repository SQL in keyed parameterized statements", () => {
    assert.match(SQL_QUERIES.domains.upsertDomain, /\$1/);
    assert.match(SQL_QUERIES.analysisRuns.markFinished, /\$2/);
    assert.match(SQL_QUERIES.domainSchedules.upsert, /\$4::timestamptz/);
    assert.doesNotMatch(JSON.stringify(SQL_QUERIES), /\$\{/);
  });
});
