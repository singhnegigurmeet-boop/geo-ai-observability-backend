import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SQL_QUERIES } from "../src/db/sql-queries.js";
import { DiffEngineService } from "../src/modules/diffs/services/diff-engine.service.js";
import { NotificationService } from "../src/modules/notifications/services/notification.service.js";
import { DomainSchedulerService } from "../src/modules/scheduler/services/domain-scheduler.service.js";
import { AnalysisRequestValidationService } from "../src/modules/analysis/services/analysis-request-validation.service.js";
import { DiscoveryCommandService } from "../src/modules/discovery/services/discovery-command.service.js";
import type { AnalysisDiffRow, EntityPathRow, ProviderSnapshotRow } from "../src/types/database.types.js";

const now = new Date("2026-05-15T12:00:00.000Z");

describe("focused services", () => {
  const domainRow = {
    domain_id: 1,
    domain: "nike.com",
    created_on: now,
    updated_on: now,
    is_active: true
  };

  const path = (overrides: Partial<EntityPathRow>): EntityPathRow => ({
    path_id: overrides.path_id ?? 1,
    domain_id: overrides.domain_id ?? 1,
    category_id: overrides.category_id ?? 1,
    brand_id: overrides.brand_id ?? null,
    product_id: overrides.product_id ?? null,
    context_id: overrides.context_id ?? null,
    path_type: overrides.path_type ?? "category",
    created_on: now,
    updated_on: now,
    is_active: true
  });

  it("analysis validation loads top 5 category paths for domain-only requests", async () => {
    const service = new AnalysisRequestValidationService({
      domainsRepository: {
        async getActiveDomainByName(domain: string) {
          assert.equal(domain, "nike.com");
          return domainRow;
        }
      },
      entityPathsRepository: {
        async getTopCategoryPathsForDomain(domainId: number, limit?: number) {
          assert.equal(domainId, 1);
          assert.equal(limit, 5);
          return [1, 2, 3, 4, 5].map((categoryId) =>
            path({ path_id: categoryId, category_id: categoryId, path_type: "category" })
          );
        },
        async validateCategoryPath() {
          throw new Error("validateCategoryPath should not be called");
        },
        async validateBrandPath() {
          throw new Error("validateBrandPath should not be called");
        },
        async validateProductContextPath() {
          throw new Error("validateProductContextPath should not be called");
        },
        async getUseContextsForProductPath() {
          throw new Error("getUseContextsForProductPath should not be called");
        }
      }
    });

    const result = await service.validateRequest({ domain: "https://www.nike.com/sale" });

    assert.equal(result.normalizedDomain, "nike.com");
    assert.equal(result.paths.length, 5);
    assert.deepEqual(
      result.paths.map((resolvedPath) => resolvedPath.categoryId),
      [1, 2, 3, 4, 5]
    );
  });

  it("analysis validation rejects invalid category/brand/product paths", async () => {
    const service = new AnalysisRequestValidationService({
      domainsRepository: {
        async getActiveDomainByName() {
          return domainRow;
        }
      },
      entityPathsRepository: {
        async getTopCategoryPathsForDomain() {
          return [];
        },
        async validateCategoryPath() {
          return path({ path_type: "category" });
        },
        async validateBrandPath() {
          return path({ path_id: 2, brand_id: 2, path_type: "brand" });
        },
        async validateProductContextPath() {
          return null;
        },
        async getUseContextsForProductPath() {
          return [];
        }
      }
    });

    await assert.rejects(
      service.validateRequest({
        domain: "nike.com",
        categories: [
          {
            categoryId: 1,
            brands: [
              {
                brandId: 2,
                products: [{ productId: 3, useContextIds: [999] }]
              }
            ]
          }
        ]
      }),
      /Invalid domain\/category\/brand\/product\/use_context path/
    );
  });

  it("discovery requests create pending work and do not run analysis", async () => {
    let analysisWasRun = false;
    const service = new DiscoveryCommandService({
      async createDiscoveryRequest(input) {
        assert.equal(input.kind, "product");
        return {
          request_id: 7,
          kind: "product",
          domain: "nike.com",
          category_id: 1,
          brand_id: null,
          brand_name: null,
          product_name: "Pegasus 41",
          notes: null,
          status: "pending",
          created_on: now,
          updated_on: now,
          is_active: true
        };
      },
      async listPendingDiscoveryRequests() {
        return [];
      },
      async updateDiscoveryRequestStatus() {
        return null;
      }
    } as any);

    const result = await service.createDiscoveryRequest({
      kind: "product",
      domain: "nike.com",
      productName: "Pegasus 41",
      categoryId: 1
    });

    assert.equal(result.statusCode, 201);
    assert.equal(result.body.discovery_request.status, "pending");
    assert.equal(result.body.analysis_started, false);
    assert.equal(analysisWasRun, false);
  });

  it("scheduler scaffold no longer enqueues V5 domain-only analysis jobs", async () => {
    const service = new DomainSchedulerService();

    const result = await service.enqueueDueDomains();

    assert.deepEqual(result, []);
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
