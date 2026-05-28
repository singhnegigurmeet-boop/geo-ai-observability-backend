# GEO AI Observability Backend

V6 hierarchy-aware backend for GEO analysis orchestration.

The active runtime is intentionally a scaffold: it validates V6 analysis requests, persists runs and run items in PostgreSQL, queues run and item jobs with ID-only payloads, and exposes run status APIs. Provider execution, scoring, Elasticsearch analysis traces, scheduler business logic, crawler behavior, taxonomy bootstrap, and notifications from analysis completion are not active analysis features yet.

PostgreSQL is the business source of truth. Redis is used by BullMQ queues. Elasticsearch is initialized if configured, but V6 analysis does not write provider traces or scoring data yet.

## Current Scope

Implemented:

- Express API
- V6 `AnalysisRequest` validation
- Transactional `analysis_runs` and `analysis_run_items` creation
- `analysis_runs -> analysis_run_items -> entity_paths` status/read model
- BullMQ two-queue analysis scaffold
- Placeholder item execution that marks items `skipped`
- Run status aggregation from item statuses
- Discovery request intake
- V6 scheduler placeholder tick that enqueues no analysis work
- Log notification infrastructure, currently not wired into analysis completion

Not implemented:

- LLM prompt execution
- Provider analysis for V6 run items
- Provider scoring
- Final GEO score calculation for V6 runs
- Analysis-result Redis cache
- Analysis scheduler behavior
- Crawler
- Taxonomy bootstrap
- V5 domain-only analysis behavior

## Active API

Mounted routes:

```text
GET  /health
GET  /openapi.json
GET  /docs
POST /v1/analysis
GET  /v1/analysis/runs/:analysisRunId
GET  /v1/analysis/runs/:analysisRunId/diffs
POST /v1/discovery
```

Provider score, visibility score, and schedule routes exist in source for rebuild work, but they are not mounted in the active Express app.

## V6 Analysis Request

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

`POST /v1/analysis` validates this shape only. Flat V5 free-text analysis fields are rejected.

Example:

```bash
curl -X POST http://127.0.0.1:4000/v1/analysis \
  -H "Content-Type: application/json" \
  -d '{"domain":"nike.com","categories":[{"categoryId":1}]}'
```

Typical response:

```json
{
  "status": "queued",
  "code": "V6_ANALYSIS_RUN_QUEUED",
  "message": "V6 analysis run queued; provider execution not implemented yet.",
  "analysisRunId": 100,
  "domain": "nike.com",
  "runItemCount": 1,
  "queueStatus": "enqueued",
  "runItems": [],
  "providerExecutionStarted": false
}
```

## Run Status

Poll a run:

```bash
curl http://127.0.0.1:4000/v1/analysis/runs/100
```

The response includes the analysis run, item status summary, and joined entity path details:

```json
{
  "analysisRunId": 100,
  "domain": "nike.com",
  "requestPayload": { "domain": "nike.com" },
  "status": "processing",
  "itemStatusSummary": {
    "queued": 0,
    "processing": 0,
    "completed": 0,
    "failed": 0,
    "skipped": 1,
    "cancelled": 0
  },
  "items": [
    {
      "runItemId": 1,
      "status": "skipped",
      "pathId": 10,
      "pathType": "category",
      "domainId": 1,
      "domain": "nike.com",
      "categoryId": 1,
      "category": "Shoes",
      "brandId": null,
      "brandName": null,
      "productId": null,
      "productName": null,
      "contextId": null,
      "context": null
    }
  ]
}
```

Unknown runs return `404`.

`GET /v1/analysis/runs/:analysisRunId/diffs` currently returns `501`; V6 diffs are not rebuilt yet.

## Data Model

Core V6 tables:

- `domains`
- `categories`
- `brands`
- `products`
- `use_contexts`
- `entity_paths`
- `discovery_requests`
- `analysis_runs`
- `analysis_run_items`

Relationship:

```text
analysis_runs
  -> analysis_run_items
      -> entity_paths
```

`entity_paths` stores reusable DB-controlled hierarchy paths:

- category path
- brand path
- product + use context path

`analysis_runs` is one submitted `AnalysisRequest`.

`analysis_run_items` are concrete expanded `entity_paths` selected for that run.

Legacy/provider-related tables still exist in the schema for future rebuild work, but V6 analysis queue scaffolding does not write provider results or visibility scores.

### Discovery Requests

Discovery requests are for missing data only. They create pending verification work for an admin, crawler, or future LLM verification step. They do not run analysis and do not directly insert canonical entities into the analysis flow.

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

`discovery_requests` stores `requested_value` separately from optional context fields and later resolution fields:

```text
request_id
kind
requested_value
context_domain
context_category_id
context_brand_id
notes
status
resolved_domain_id
resolved_brand_id
resolved_product_id
resolved_path_id
created_on
updated_on
is_active
```

Allowed statuses are `pending`, `rejected`, and `resolved`. The old `approved` status is not used.

Examples:

```bash
curl -X POST http://127.0.0.1:4000/v1/discovery \
  -H "Content-Type: application/json" \
  -d '{"kind":"domain","requestedValue":"nike.com"}'

curl -X POST http://127.0.0.1:4000/v1/discovery \
  -H "Content-Type: application/json" \
  -d '{"kind":"brand","requestedValue":"Jordan","contextDomain":"nike.com"}'

curl -X POST http://127.0.0.1:4000/v1/discovery \
  -H "Content-Type: application/json" \
  -d '{"kind":"product","requestedValue":"Air Jordan 4","contextDomain":"nike.com","contextBrandId":2}'
```

## Queue Model

Active analysis queues:

```text
analysis_run_queue
analysis_run_item_queue
```

Payloads carry IDs only:

```ts
type AnalysisRunJobPayload = {
  analysisRunId: number;
};

type AnalysisRunItemJobPayload = {
  analysisRunId: number;
  runItemId: number;
};
```

No domain, category, brand, product, or use context names are placed in analysis queue payloads.

Run queue behavior:

1. Load `analysis_runs` by `analysisRunId`.
2. Load `analysis_run_items` from PostgreSQL.
3. Mark the run `processing`.
4. Enqueue one item job per queued run item.
5. If no items exist, mark the run `failed`.
6. Do not call providers.

Item queue behavior:

1. Load `analysis_run_item` and joined `entity_path` by `runItemId`.
2. Verify the item belongs to `analysisRunId`.
3. Mark item `processing`.
4. Log `Provider execution not implemented yet`.
5. Mark item `skipped`.
6. Aggregate parent run status.
7. Do not write provider analysis, visibility scores, or Elasticsearch traces.

Status aggregation:

- Any `queued` or `processing` item -> run `processing`
- All `completed` or scaffold `skipped` items -> run `completed`
- Some failed and some terminal non-failed items -> run `partial_success`
- All failed -> run `failed`
- All cancelled -> run `cancelled`
- No items -> run `failed`

## Project Structure

```text
src/
  app.ts
  main.ts
  container.ts
  db/
  lib/
  queue/
  runtime/
  modules/
    analysis/
    discovery/
    providers/
    visibility/
    diffs/
    scheduler/
    notifications/
    observability/
  repositories/
  services/
  types/
```

Important active files:

- `src/modules/analysis/routes/analysis.routes.ts`
- `src/modules/analysis/controllers/analysis.controller.ts`
- `src/modules/analysis/services/analysis-command.service.ts`
- `src/modules/analysis/services/analysis-status.service.ts`
- `src/modules/analysis/services/analysis-run-orchestrator.service.ts`
- `src/modules/analysis/services/analysis-run-item-execution.service.ts`
- `src/modules/analysis/services/analysis-run-status-aggregator.service.ts`
- `src/modules/analysis/repositories/analysis-runs.repository.ts`
- `src/modules/analysis/repositories/analysis-run-items.repository.ts`
- `src/queue/analysis-run.queue.ts`
- `src/queue/analysis-run-item.queue.ts`
- `src/runtime/analysis-run-worker.ts`
- `src/runtime/analysis-run-item-worker.ts`
- `src/types/queue.types.ts`
- `src/db/sql-queries.ts`
- `src/db/migrations/001_initial_schema.sql`

## Requirements

Tested from WSL:

- Node.js
- npm
- PostgreSQL on `localhost:5432`
- Redis on `localhost:6379`

Optional:

- Elasticsearch on `localhost:9200`
- Docker / Docker Desktop WSL integration

## Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Minimum local values:

```env
NODE_ENV=development
PORT=4000
DATABASE_URL=postgres://geo_user:geo_pass_123@localhost:5432/geo_observability
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_NODE=http://localhost:9200
SCHEDULER_TICK_MS=60000
```

Provider keys may remain empty for the current V6 scaffold because provider execution is not active.

## Install

```bash
cd /mnt/d/geo-ai-observability-backend
npm install
```

## Run Migrations

```bash
npm run migrate
```

Local migrations are reset-style. The command drops known application tables, recreates the current schema from `src/db/migrations/001_initial_schema.sql`, and verifies required tables.

## Build And Test

```bash
npm run build
npm test
```

Or from Windows PowerShell through WSL:

```powershell
wsl bash -lc "cd /mnt/d/geo-ai-observability-backend && npm run build && npm test"
```

## Run The API And Workers

```bash
npm run build
npm start
```

This starts one Node process containing:

- Express API
- Analysis run worker
- Analysis run item worker
- V6 scheduler placeholder worker
- Notification worker

Shutdown closes the HTTP server, BullMQ workers, queues, Redis connection, PostgreSQL pool, and Elasticsearch client.

Health check:

```bash
curl http://127.0.0.1:4000/health
```

Expected:

```json
{"status":"ok"}
```

## Scripts

```bash
npm run dev                 # tsx watch src/main.ts
npm run migrate             # reset local app tables and apply current SQL schema
npm run build               # compile TypeScript
npm test                    # run node:test suite
npm run typecheck           # TypeScript no-emit check
npm start                   # run compiled app
npm run elasticsearch:setup # create observability indexes
```

Docker helper scripts are present in `package.json`, but are optional for local WSL development.

## Development Rules

- Keep V5 domain-only analysis behavior inactive.
- Keep PostgreSQL as the source of truth.
- Keep analysis queue payloads ID-only.
- Do not add provider calls, scoring, cache semantics, Elasticsearch writes, scheduler behavior, crawler behavior, or taxonomy bootstrap as part of queue/status scaffolding.
- Update this README and `FLOW.md` whenever route, queue, DB, worker, or runtime behavior changes.
