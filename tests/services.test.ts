import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SQL_QUERIES } from "../src/db/sql-queries.js";
import { DiffEngineService } from "../src/modules/diffs/services/diff-engine.service.js";
import { NotificationService } from "../src/modules/notifications/services/notification.service.js";
import { DomainSchedulerService } from "../src/modules/scheduler/services/domain-scheduler.service.js";
import { AnalysisCommandService } from "../src/modules/analysis/services/analysis-command.service.js";
import { AnalysisRunItemExecutionService } from "../src/modules/analysis/services/analysis-run-item-execution.service.js";
import { AnalysisRunOrchestratorService } from "../src/modules/analysis/services/analysis-run-orchestrator.service.js";
import { AnalysisRunStatusAggregatorService } from "../src/modules/analysis/services/analysis-run-status-aggregator.service.js";
import { AnalysisRequestValidationService } from "../src/modules/analysis/services/analysis-request-validation.service.js";
import { AnalysisStatusService } from "../src/modules/analysis/services/analysis-status.service.js";
import { DiscoveryCommandService } from "../src/modules/discovery/services/discovery-command.service.js";
import type {
  AnalysisDiffRow,
  AnalysisRunItemStatus,
  EntityPathRow,
  ProviderSnapshotRow
} from "../src/types/database.types.js";

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

  const createCommandHarness = (entityPathsRepository: Record<string, unknown>) => {
    const createdRuns: unknown[] = [];
    const createdItemPathIds: number[][] = [];
    const queuedRunJobs: unknown[] = [];
    const validationService = new AnalysisRequestValidationService({
      domainsRepository: {
        async getActiveDomainByName() {
          return domainRow;
        }
      },
      entityPathsRepository: entityPathsRepository as any
    });
    const service = new AnalysisCommandService(
      validationService,
      {
        async createAnalysisRunWithItems(input: { domainId: number; requestPayload: unknown; pathIds: number[] }) {
          createdRuns.push(input);
          createdItemPathIds.push(input.pathIds);
          const analysisRun = {
            analysis_run_id: 100,
            domain_id: 1,
            request_payload: input.requestPayload,
            status: "queued",
            created_on: now,
            updated_on: now,
            is_active: true
          };

          return {
            analysisRun,
            runItems: input.pathIds.map((pathId, index) => ({
              run_item_id: index + 1,
              analysis_run_id: analysisRun.analysis_run_id,
              path_id: pathId,
              status: "queued",
              created_on: now,
              updated_on: now,
              is_active: true
            }))
          };
        }
      } as any,
      {} as any,
      {
        async add(_name: string, payload: unknown) {
          queuedRunJobs.push(payload);
          return { id: "job-1" };
        }
      }
    );

    return { service, createdRuns, createdItemPathIds, queuedRunJobs };
  };

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

  it("domain-only analysis creates one run and top 5 category run items", async () => {
    const { service, createdRuns, createdItemPathIds, queuedRunJobs } = createCommandHarness({
      async getTopCategoryPathsForDomain() {
        return [11, 12, 13, 14, 15].map((pathId) =>
          path({ path_id: pathId, category_id: pathId, path_type: "category" })
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
    });

    const result = await service.enqueueAnalysis({ domain: "nike.com" }, "127.0.0.1");

    assert.equal(result.statusCode, 202);
    assert.equal(result.body.analysisRunId, 100);
    assert.equal(result.body.providerExecutionStarted, false);
    assert.equal(result.body.queueStatus, "enqueued");
    assert.equal(result.body.message, "V6 analysis run queued; provider execution not implemented yet.");
    assert.equal(createdRuns.length, 1);
    assert.deepEqual(createdItemPathIds, [[11, 12, 13, 14, 15]]);
    assert.deepEqual(queuedRunJobs, [{ analysisRunId: 100 }]);
  });

  it("POST analysis command uses transactional run and item creation", async () => {
    const { service, createdRuns, createdItemPathIds, queuedRunJobs } = createCommandHarness({
      async getTopCategoryPathsForDomain() {
        return [11].map((pathId) => path({ path_id: pathId, category_id: pathId, path_type: "category" }));
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
    });

    const result = await service.enqueueAnalysis({ domain: "nike.com" }, "127.0.0.1");

    assert.equal(result.statusCode, 202);
    assert.equal(createdRuns.length, 1);
    assert.deepEqual(createdItemPathIds, [[11]]);
    assert.equal(result.body.runItemCount, 1);
    assert.deepEqual(queuedRunJobs, [{ analysisRunId: 100 }]);
    assert.deepEqual(Object.keys(queuedRunJobs[0] as Record<string, unknown>).sort(), ["analysisRunId"]);
  });

  it("analysis run orchestrator enqueues one item job per queued run item with ID-only payloads", async () => {
    const queuedItemJobs: unknown[] = [];
    const runStatusUpdates: string[] = [];
    const service = new AnalysisRunOrchestratorService(
      {
        async getAnalysisRunById(analysisRunId: number) {
          assert.equal(analysisRunId, 100);
          return {
            analysis_run_id: 100,
            domain_id: 1,
            request_payload: { domain: "nike.com" },
            status: "queued",
            created_on: now,
            updated_on: now,
            is_active: true
          };
        },
        async updateAnalysisRunStatus(_analysisRunId: number, status: string) {
          runStatusUpdates.push(status);
          return null;
        }
      } as any,
      {
        async listRunItems(analysisRunId: number) {
          assert.equal(analysisRunId, 100);
          return [
            {
              run_item_id: 1,
              analysis_run_id: 100,
              path_id: 11,
              status: "queued",
              created_on: now,
              updated_on: now,
              is_active: true
            },
            {
              run_item_id: 2,
              analysis_run_id: 100,
              path_id: 12,
              status: "queued",
              created_on: now,
              updated_on: now,
              is_active: true
            }
          ];
        }
      } as any,
      {
        async add(_name: string, payload: unknown) {
          queuedItemJobs.push(payload);
          return { id: queuedItemJobs.length };
        }
      } as any,
      {
        async aggregateRunStatus() {
          throw new Error("aggregateRunStatus should not be called while queued items are enqueued");
        }
      } as any
    );

    const result = await service.processAnalysisRun({ analysisRunId: 100 });

    assert.equal(result.enqueuedRunItemCount, 2);
    assert.deepEqual(runStatusUpdates, ["processing"]);
    assert.deepEqual(queuedItemJobs, [
      { analysisRunId: 100, runItemId: 1 },
      { analysisRunId: 100, runItemId: 2 }
    ]);
    assert.deepEqual(
      queuedItemJobs.map((job) => Object.keys(job as Record<string, unknown>).sort()),
      [
        ["analysisRunId", "runItemId"],
        ["analysisRunId", "runItemId"]
      ]
    );
  });

  it("analysis item worker service loads entity path, skips provider execution, and aggregates status", async () => {
    const itemStatusUpdates: string[] = [];
    let loadedRunItemId: number | null = null;
    let aggregateRunId: number | null = null;
    const service = new AnalysisRunItemExecutionService(
      {
        async getRunItemWithPathById(runItemId: number) {
          loadedRunItemId = runItemId;
          return {
            run_item_id: runItemId,
            analysis_run_id: 100,
            path_id: 200,
            run_item_status: "queued",
            run_item_created_on: now,
            run_item_updated_on: now,
            run_item_is_active: true,
            domain_id: 1,
            category_id: 2,
            brand_id: null,
            product_id: null,
            context_id: null,
            path_type: "category",
            path_created_on: now,
            path_updated_on: now,
            path_is_active: true,
            domain: "nike.com",
            category: "Running",
            brand_name: null,
            product_name: null,
            context: null
          };
        },
        async updateRunItemStatus(_runItemId: number, status: string) {
          itemStatusUpdates.push(status);
          return null;
        }
      } as any,
      {
        async aggregateRunStatus(analysisRunId: number) {
          aggregateRunId = analysisRunId;
          return "completed";
        }
      } as any
    );

    const result = await service.processAnalysisRunItem({ analysisRunId: 100, runItemId: 7 });

    assert.equal(loadedRunItemId, 7);
    assert.deepEqual(itemStatusUpdates, ["processing", "skipped"]);
    assert.equal(aggregateRunId, 100);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "Provider execution not implemented yet");
  });

  it("analysis run status aggregator rolls item statuses into parent run status", async () => {
    const updatedStatuses: string[] = [];
    const aggregator = new AnalysisRunStatusAggregatorService(
      {
        async updateAnalysisRunStatus(_analysisRunId: number, status: string) {
          updatedStatuses.push(status);
          return null;
        }
      } as any,
      {
        async listRunItems() {
          return [
            { status: "skipped" },
            { status: "skipped" }
          ];
        }
      } as any
    );

    assert.equal(aggregator.resolveRunStatus(["completed", "completed"]), "completed");
    assert.equal(aggregator.resolveRunStatus(["skipped", "skipped"]), "completed");
    assert.equal(aggregator.resolveRunStatus(["completed", "failed"]), "partial_success");
    assert.equal(aggregator.resolveRunStatus(["failed", "failed"]), "failed");
    assert.equal(aggregator.resolveRunStatus(["queued", "skipped"]), "processing");

    const status = await aggregator.aggregateRunStatus(100);

    assert.equal(status, "completed");
    assert.deepEqual(updatedStatuses, ["completed"]);
  });

  it("analysis run repository rolls back run creation when item creation fails", async () => {
    process.env.DATABASE_URL ??= "postgres://user:password@127.0.0.1:5432/test";
    process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
    process.env.ELASTICSEARCH_NODE ??= "http://127.0.0.1:9200";

    const [{ AnalysisRunsRepository }, { pool }] = await Promise.all([
      import("../src/modules/analysis/repositories/analysis-runs.repository.js"),
      import("../src/lib/postgres.js")
    ]);
    const originalConnect = pool.connect.bind(pool);
    const calls: string[] = [];
    const fakeClient = {
      async query(sql: string) {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          calls.push(sql);
          return { rows: [] };
        }

        if (sql.includes("INSERT INTO analysis_runs")) {
          calls.push("insert_run");
          return {
            rows: [
              {
                analysis_run_id: 500,
                domain_id: 1,
                request_payload: { domain: "nike.com" },
                status: "queued",
                created_on: now,
                updated_on: now,
                is_active: true
              }
            ]
          };
        }

        if (sql.includes("INSERT INTO analysis_run_items")) {
          calls.push("insert_items");
          throw new Error("simulated item insert failure");
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      },
      release() {
        calls.push("release");
      }
    };

    (pool as any).connect = async () => fakeClient;

    try {
      const repository = new AnalysisRunsRepository();

      await assert.rejects(
        repository.createAnalysisRunWithItems({
          domainId: 1,
          requestPayload: { domain: "nike.com" },
          pathIds: [999],
          status: "queued"
        }),
        /simulated item insert failure/
      );

      assert.deepEqual(calls, ["BEGIN", "insert_run", "insert_items", "ROLLBACK", "release"]);
    } finally {
      (pool as any).connect = originalConnect;
    }
  });

  it("selected categories create category-level run items only", async () => {
    const { service, createdItemPathIds } = createCommandHarness({
      async getTopCategoryPathsForDomain() {
        return [];
      },
      async validateCategoryPath(_domainId: number, categoryId: number) {
        return path({ path_id: categoryId + 20, category_id: categoryId, path_type: "category" });
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
    });

    const result = await service.enqueueAnalysis(
      { domain: "nike.com", categories: [{ categoryId: 1 }, { categoryId: 2 }] },
      "127.0.0.1"
    );

    assert.equal(result.statusCode, 202);
    assert.deepEqual(createdItemPathIds, [[21, 22]]);
  });

  it("selected brands create brand-level run items only", async () => {
    const { service, createdItemPathIds } = createCommandHarness({
      async getTopCategoryPathsForDomain() {
        return [];
      },
      async validateCategoryPath() {
        throw new Error("validateCategoryPath should not be called");
      },
      async validateBrandPath(_domainId: number, categoryId: number, brandId: number) {
        return path({ path_id: 30 + brandId, category_id: categoryId, brand_id: brandId, path_type: "brand" });
      },
      async validateProductContextPath() {
        throw new Error("validateProductContextPath should not be called");
      },
      async getUseContextsForProductPath() {
        throw new Error("getUseContextsForProductPath should not be called");
      }
    });

    const result = await service.enqueueAnalysis(
      { domain: "nike.com", categories: [{ categoryId: 1, brands: [{ brandId: 10 }] }] },
      "127.0.0.1"
    );

    assert.equal(result.statusCode, 202);
    assert.deepEqual(createdItemPathIds, [[40]]);
  });

  it("products with useContextIds create product_context run items", async () => {
    const { service, createdItemPathIds } = createCommandHarness({
      async getTopCategoryPathsForDomain() {
        return [];
      },
      async validateCategoryPath() {
        throw new Error("validateCategoryPath should not be called");
      },
      async validateBrandPath(_domainId: number, categoryId: number, brandId: number) {
        return path({ path_id: 40, category_id: categoryId, brand_id: brandId, path_type: "brand" });
      },
      async validateProductContextPath(
        _domainId: number,
        categoryId: number,
        brandId: number,
        productId: number,
        contextId: number
      ) {
        return path({
          path_id: 50 + contextId,
          category_id: categoryId,
          brand_id: brandId,
          product_id: productId,
          context_id: contextId,
          path_type: "product_context"
        });
      },
      async getUseContextsForProductPath() {
        throw new Error("getUseContextsForProductPath should not be called");
      }
    });

    const result = await service.enqueueAnalysis(
      {
        domain: "nike.com",
        categories: [
          {
            categoryId: 1,
            brands: [{ brandId: 10, products: [{ productId: 100, useContextIds: [5, 6] }] }]
          }
        ]
      },
      "127.0.0.1"
    );

    assert.equal(result.statusCode, 202);
    assert.deepEqual(createdItemPathIds, [[55, 56]]);
  });

  it("products without useContextIds return a blocking response and create no run items", async () => {
    const { service, createdRuns, createdItemPathIds } = createCommandHarness({
      async getTopCategoryPathsForDomain() {
        return [];
      },
      async validateCategoryPath() {
        throw new Error("validateCategoryPath should not be called");
      },
      async validateBrandPath(_domainId: number, categoryId: number, brandId: number) {
        return path({ path_id: 40, category_id: categoryId, brand_id: brandId, path_type: "brand" });
      },
      async validateProductContextPath() {
        throw new Error("validateProductContextPath should not be called");
      },
      async getUseContextsForProductPath(_domainId: number, categoryId: number, brandId: number, productId: number) {
        return [
          path({
            path_id: 55,
            category_id: categoryId,
            brand_id: brandId,
            product_id: productId,
            context_id: 5,
            path_type: "product_context"
          })
        ];
      }
    });

    const result = await service.enqueueAnalysis(
      {
        domain: "nike.com",
        categories: [{ categoryId: 1, brands: [{ brandId: 10, products: [{ productId: 100 }] }] }]
      },
      "127.0.0.1"
    );

    assert.equal(result.statusCode, 422);
    assert.equal(result.body.details.blocking_reason, "PRODUCT_USE_CONTEXT_SELECTION_NOT_IMPLEMENTED");
    assert.deepEqual(createdRuns, []);
    assert.deepEqual(createdItemPathIds, []);
  });

  it("analysis status returns run with joined item path details and summary", async () => {
    const item = (runItemId: number, status: AnalysisRunItemStatus) => ({
      run_item_id: runItemId,
      analysis_run_id: 100,
      path_id: 200 + runItemId,
      run_item_status: status,
      run_item_created_on: now,
      run_item_updated_on: now,
      run_item_is_active: true,
      domain_id: 1,
      category_id: 2,
      brand_id: runItemId === 1 ? null : 3,
      product_id: runItemId === 3 ? 4 : null,
      context_id: runItemId === 3 ? 5 : null,
      path_type: runItemId === 3 ? "product_context" : runItemId === 2 ? "brand" : "category",
      path_created_on: now,
      path_updated_on: now,
      path_is_active: true,
      domain: "nike.com",
      category: "Running",
      brand_name: runItemId === 1 ? null : "Nike",
      product_name: runItemId === 3 ? "Pegasus 41" : null,
      context: runItemId === 3 ? "Marathon training" : null
    });
    const service = new AnalysisStatusService(
      {
        async getAnalysisRunWithItems(analysisRunId: number) {
          assert.equal(analysisRunId, 100);
          return {
            analysis_run_id: 100,
            domain_id: 1,
            domain: "nike.com",
            request_payload: { domain: "nike.com" },
            status: "queued",
            created_on: now,
            updated_on: now,
            is_active: true
          };
        }
      } as any,
      {
        async getRunItemsWithPaths(analysisRunId: number) {
          assert.equal(analysisRunId, 100);
          return [item(1, "queued"), item(2, "completed"), item(3, "failed")];
        }
      } as any
    );

    const result = await service.getAnalysisRunStatus(100);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.analysisRunId, 100);
    assert.equal(result.body.items[2].pathType, "product_context");
    assert.equal(result.body.items[2].productName, "Pegasus 41");
    assert.deepEqual(result.body.itemStatusSummary, {
      queued: 1,
      processing: 0,
      completed: 1,
      failed: 1,
      skipped: 0,
      cancelled: 0
    });
  });

  it("analysis status returns 404 for unknown runs", async () => {
    const service = new AnalysisStatusService(
      {
        async getAnalysisRunWithItems() {
          return null;
        }
      } as any,
      {
        async getRunItemsWithPaths() {
          throw new Error("getRunItemsWithPaths should not be called");
        }
      } as any
    );

    const result = await service.getAnalysisRunStatus(999);

    assert.equal(result.statusCode, 404);
    assert.equal(result.body.status, "error");
    assert.equal(result.body.error, "Analysis run not found");
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
          return { analysis_run_id: 1 };
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
    assert.match(SQL_QUERIES.analysisRuns.updateStatus, /\$2/);
    assert.match(SQL_QUERIES.analysisRunItems.createMany, /unnest\(\$2::integer\[\]\)/);
    assert.match(SQL_QUERIES.domainSchedules.upsert, /\$4::timestamptz/);
    assert.doesNotMatch(JSON.stringify(SQL_QUERIES), /\$\{/);
  });
});
