# Backend Execution Flow

This document describes the active V6 runtime flow. It intentionally excludes V5 domain-only provider execution, final scoring, cache lookups, scheduler analysis enqueueing, and Elasticsearch analysis trace writes because those are not active in the current backend.

## Documentation Rule

Markdown files are project documentation source of truth. Any route, worker, queue, database, or runtime behavior change should update `README.md` and this file in the same change.

## Runtime Process

The backend runs as one combined Node process:

```text
node dist/main.js
```

Startup flow:

```text
src/main.ts
  -> imports wired dependencies from src/container.ts
  -> createApp(...)
  -> observabilityIndexService.initialize()
  -> createAnalysisRunWorker(...)
  -> createAnalysisRunItemWorker(...)
  -> createSchedulerWorker(...)
  -> createNotificationWorker(...)
  -> ensureV6SchedulerRepeatableJob()
  -> app.listen(env.PORT)
```

Shutdown flow:

```text
SIGINT/SIGTERM
  -> close HTTP server
  -> close workers
  -> close BullMQ queues
  -> quit Redis connection
  -> end PostgreSQL pool
  -> close Elasticsearch client
```

## Active Express App

`src/app.ts` mounts:

```text
GET  /health
GET  /openapi.json
GET  /docs
POST /v1/analysis
GET  /v1/analysis/runs/:analysisRunId
GET  /v1/analysis/runs/:analysisRunId/diffs
POST /v1/discovery
```

Provider score, visibility score, and schedule route modules remain in source for future rebuild work, but they are not mounted in the active app.

## Dependency Wiring

`src/container.ts` creates shared infrastructure and services once:

```text
analysisRequestValidationService
analysisCommandService
analysisStatusService
analysisRunStatusAggregatorService
analysisRunOrchestratorService
analysisRunItemExecutionService
discoveryCommandService
domainSchedulerService
notificationService
observabilityIndexService
```

Request handlers and job handlers use these shared instances. They should not create new PostgreSQL pools, Redis connections, BullMQ queues, or Elasticsearch clients.

## Analysis Request Flow

Endpoint:

```http
POST /v1/analysis
```

Request body:

```ts
type AnalysisRequest = {
  domain: string;
  categories?: Array<{
    categoryId: number;
    brands?: Array<{
      brandId: number;
      products?: Array<{
        productId: number;
        useContextIds?: number[];
      }>;
    }>;
  }>;
};
```

Call flow:

```text
analysis.routes.ts
  -> validateBody(requestSchema)
  -> AnalysisController.handleAnalysisRequest(req)
  -> AnalysisCommandService.enqueueAnalysis(request, ipAddress)
  -> AnalysisRequestValidationService.validateRequest(request)
  -> AnalysisRunsRepository.createAnalysisRunWithItems(...)
  -> analysisRunQueue.add("analysis-run", { analysisRunId })
  -> return 202
```

Validation behavior:

1. Normalize the submitted domain.
2. Load the active domain from PostgreSQL.
3. Resolve requested categories, brands, products, and use contexts through `entity_paths`.
4. For domain-only requests, select top category paths for the domain.
5. For products without `useContextIds`, return a blocking response because use-context auto-selection is not implemented.
6. Return concrete path IDs for run item creation.

Creation behavior:

1. Insert one `analysis_runs` row.
2. Insert one `analysis_run_items` row per selected `entity_paths.path_id`.
3. Do both steps in one PostgreSQL transaction.
4. If item insertion fails, roll back the run insertion.
5. Enqueue exactly one run-level queue job after persistence succeeds.

PostgreSQL is the source of truth. Queue payloads carry only IDs.

## Transaction Boundary

Source files:

```text
src/lib/postgres.ts
src/modules/analysis/repositories/analysis-runs.repository.ts
```

Transaction helper:

```text
withTransaction(callback)
  -> BEGIN
  -> callback(client)
  -> COMMIT
  -> on error ROLLBACK
  -> release client
```

`createAnalysisRunWithItems(...)` uses this helper for initial run creation.

Important distinction:

- Initial creation is atomic.
- Later item execution is allowed to become partial per `analysis_run_item`.

## Data Model Flow

Relationship:

```text
analysis_runs
  -> analysis_run_items
      -> entity_paths
```

Core tables:

```text
domains
categories
brands
products
use_contexts
entity_paths
discovery_requests
analysis_runs
analysis_run_items
```

`analysis_runs` stores one submitted request.

`analysis_run_items` stores concrete expanded path selections for that run.

`entity_paths` stores reusable DB-controlled hierarchy paths.

## Analysis Queues

Queue files:

```text
src/queue/analysis-run.queue.ts
src/queue/analysis-run-item.queue.ts
```

Queue names:

```text
analysis_run_queue
analysis_run_item_queue
```

Payload types:

```ts
type AnalysisRunJobPayload = {
  analysisRunId: number;
};

type AnalysisRunItemJobPayload = {
  analysisRunId: number;
  runItemId: number;
};
```

No domain/category/brand/product/use context names are placed in queue payloads.

## Analysis Run Worker Flow

Worker file:

```text
src/runtime/analysis-run-worker.ts
```

Service file:

```text
src/modules/analysis/services/analysis-run-orchestrator.service.ts
```

Call flow:

```text
Worker receives { analysisRunId }
  -> AnalysisRunOrchestratorService.processAnalysisRun(payload)
  -> getAnalysisRunById(analysisRunId)
  -> listRunItems(analysisRunId)
  -> if no items, mark analysis_run failed
  -> mark analysis_run processing
  -> for each queued item:
       analysisRunItemQueue.add("analysis-run-item", { analysisRunId, runItemId })
  -> if no queued items, aggregate parent status
```

The run worker does not call providers and does not write provider outputs.

## Analysis Run Item Worker Flow

Worker file:

```text
src/runtime/analysis-run-item-worker.ts
```

Service file:

```text
src/modules/analysis/services/analysis-run-item-execution.service.ts
```

Call flow:

```text
Worker receives { analysisRunId, runItemId }
  -> AnalysisRunItemExecutionService.processAnalysisRunItem(payload)
  -> getRunItemWithPathById(runItemId)
  -> verify item.analysis_run_id === analysisRunId
  -> update item status to processing
  -> log "Provider execution not implemented yet"
  -> update item status to skipped
  -> aggregate parent analysis_run status
```

Current placeholder behavior:

- No provider calls.
- No LLM prompts.
- No provider_analysis writes.
- No provider_snapshots writes.
- No visibility_scores writes.
- No Elasticsearch analysis trace writes.

## Run Status Aggregation

Service file:

```text
src/modules/analysis/services/analysis-run-status-aggregator.service.ts
```

Rules:

```text
any queued/processing item -> processing
all completed/skipped items -> completed
all failed items -> failed
some failed and some terminal non-failed items -> partial_success
all cancelled items -> cancelled
no items -> failed
```

During the scaffold phase, `skipped` is treated as an expected provider-execution placeholder.

## Run Status Read Flow

Endpoint:

```http
GET /v1/analysis/runs/:analysisRunId
```

Source files:

```text
src/modules/analysis/routes/analysis.routes.ts
src/modules/analysis/controllers/analysis.controller.ts
src/modules/analysis/services/analysis-status.service.ts
src/modules/analysis/repositories/analysis-run-items.repository.ts
src/db/sql-queries.ts
```

Call flow:

```text
AnalysisController.handleRunStatusRequest(req)
  -> AnalysisStatusService.getAnalysisRunStatus(analysisRunId)
  -> AnalysisRunsRepository.getAnalysisRunWithItems(analysisRunId)
  -> if missing, return 404
  -> AnalysisRunItemsRepository.getRunItemsWithPaths(analysisRunId)
  -> summarize item statuses
  -> map joined entity path details
  -> return 200
```

Returned item details include:

```text
runItemId
status
pathId
pathType
domainId
domain
categoryId
category
brandId
brandName
productId
productName
contextId
context
createdOn
updatedOn
```

`itemStatusSummary` contains:

```text
queued
processing
completed
failed
skipped
cancelled
```

## Diffs Endpoint

Endpoint:

```http
GET /v1/analysis/runs/:analysisRunId/diffs
```

Current behavior:

```text
501 V6_ANALYSIS_DIFFS_REBUILD_REQUIRED
```

V6 diffs are not rebuilt yet.

## Discovery Flow

Active endpoints:

```text
POST /v1/discovery
```

Discovery stores pending domain, brand, or product requests in `discovery_requests`. It does not run analysis.

Public request shape:

```ts
type DiscoveryRequest =
  | {
      kind: "domain";
      requestedValue: string;
      contextCategoryId?: number;
      notes?: string;
    }
  | {
      kind: "brand";
      requestedValue: string;
      contextDomain: string;
      contextCategoryId?: number;
      notes?: string;
    }
  | {
      kind: "product";
      requestedValue: string;
      contextDomain: string;
      contextCategoryId?: number;
      contextBrandId?: number;
      notes?: string;
    };
```

Discovery write flow:

```text
discovery.routes.ts
  -> validateBody(discoveryRequestSchema)
  -> DiscoveryController.handleDiscoveryRequest(req)
  -> DiscoveryCommandService.createDiscoveryRequest(request)
  -> DiscoveryRequestsRepository.createDiscoveryRequest(request)
  -> INSERT discovery_requests
  -> return 201 with analysis_started: false
```

Stored fields:

```text
requested_value
context_domain
context_category_id
context_brand_id
resolved_domain_id
resolved_brand_id
resolved_product_id
resolved_path_id
```

Allowed statuses:

```text
pending
rejected
resolved
```

`approved` is not used. Resolution means canonical DB entity/path was found or created by a later admin, crawler, or verification workflow.

## Scheduler Placeholder Flow

Queue file:

```text
src/queue/scheduler.queue.ts
```

Worker file:

```text
src/runtime/scheduler-worker.ts
```

Service file:

```text
src/modules/scheduler/services/domain-scheduler.service.ts
```

Current behavior:

```text
ensureV6SchedulerRepeatableJob()
  -> enqueue repeatable "v6-scheduler-placeholder" tick
  -> scheduler worker receives tick
  -> DomainSchedulerService.enqueueDueDomains()
  -> log placeholder message
  -> return []
```

The scheduler does not enqueue analysis jobs in the current V6 scaffold.

## Notification Infrastructure

Queue file:

```text
src/queue/notification.queue.ts
```

Worker file:

```text
src/runtime/notification-worker.ts
```

Service file:

```text
src/modules/notifications/services/notification.service.ts
```

Notifications can be queued by code that has `analysis_diffs`, but active V6 analysis item execution does not create diffs or notifications. Notification delivery is log-channel only.

## Elasticsearch

Startup initializes observability indexes through:

```text
src/modules/observability/services/observability-index.service.ts
```

Current V6 analysis queue scaffold does not write provider prompt/response traces.

Elasticsearch remains observability infrastructure, not the business source of truth.

## Testing Flow

Primary verification command from Windows PowerShell:

```powershell
wsl bash -lc "cd /mnt/d/geo-ai-observability-backend && npm run build && npm test"
```

Tests cover:

- V6 request shape validation
- Rejection of flat V5-style analysis fields
- Transactional analysis run + item creation
- Rollback when item insertion fails
- Status API with joined entity path details
- Unknown run `404`
- One run-level queue job from `POST /v1/analysis`
- One item-level job per queued run item
- ID-only queue payloads
- Placeholder item execution with `skipped`
- Parent run status aggregation
- Scheduler placeholder not enqueueing V5 domain-only analysis jobs

## Current Caveats

- Domain-only V6 requests still expand to top category paths for the domain; this is V6 entity-path behavior, not V5 provider execution.
- Product requests without `useContextIds` return a blocking response until use-context selection is implemented.
- Provider adapters and scoring services remain in source, but active V6 analysis workers do not call them.
- Provider/visibility/schedule route files remain in source, but are not mounted by `src/app.ts`.
