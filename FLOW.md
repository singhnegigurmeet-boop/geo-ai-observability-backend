# Backend Execution Flow

> V6 rebuild note: this flow document still contains V5 domain-only architecture notes for reference. Active runtime wiring has been neutralized for the V6 hierarchy-aware rebuild and should not be treated as implementing the sections below yet.

This document explains how the backend starts, which functions are called, and what each layer does.

## Documentation Rule

Markdown files are the project source of truth. Any change to architecture, routes, worker flow, scoring logic, database behavior, Redis caching/rate limiting, Elasticsearch indexing, provider execution, or local run commands must update the relevant `.md` file in the same change.

## Runtime Process

The backend runs as one combined process.

## Modular Monolith Structure

The backend remains one codebase and one application. Domain-specific code is grouped by module:

```text
src/modules/
  analysis/
  providers/
  visibility/
  diffs/
  scheduler/
  notifications/
  observability/
```

Inside each module, files are grouped by layer:

```text
controllers/
routes/
services/
repositories/
```

Provider adapters live under `src/modules/providers/adapters`.

Shared runtime and infrastructure code stays outside modules:

```text
src/config
src/db
src/lib
src/middleware
src/queue
src/runtime
src/types
src/utils
```

Do not convert this into microservices without a clear operational reason such as separate scaling, team ownership, deployment cycle, workload isolation, or security boundary.

Start command:

```bash
npm start
```

For a clean checkout, build before starting:

```bash
npm install
npm run build
npm run migrate
npm start
```

This starts:

1. API serve
2. Analysis worke
3. Scheduler worke
4. Notification worke

in the same Node process and shuts them down together.

The API and worker still communicate through BullMQ, which stores queue state in Redis.

PostgreSQL, Redis, BullMQ queue, Elasticsearch, repositories, provider adapters, and core services are created once at startup and reused. Request handlers and job handlers should not create new infrastructure objects.

```text
HTTP client
  -> API process
  -> Redis / PostgreSQL lookup
  -> BullMQ job
  -> Worker process
  -> analysis_runs processing update
  -> Provider execution
  -> PostgreSQL writes
  -> Elasticsearch trace indexing
  -> Redis cache write
  -> analysis_runs final status update
  -> Diff engine
  -> Notification queue
```

## API Startup

Start command:

```bash
node dist/main.js
```

Source entrypoint:

```text
src/main.ts
```

Call flow:

```text
main.ts
  -> container.ts
  -> createApp(route services)
  -> observabilityIndexService.initialize()
  -> createAnalysisWorker(analysisJobService)
  -> createSchedulerWorker(domainSchedulerService)
  -> createNotificationWorker(notificationService)
  -> ensureDomainSchedulerRepeatableJob()
  -> app.listen(env.PORT)
```

What happens:

1. `main.ts` imports wired services from `src/container.ts`.
2. `main.ts` imports `createApp` from `src/app.ts`.
3. `createApp(...)` builds the Express app with focused route services.
4. Express registers JSON parsing.
5. Express registers `GET /health`.
6. Express registers `GET /openapi.json`.
7. Express registers Swagger UI at `/docs`.
8. Express registers `/v1/analysis`.
9. Express registers `/v1/domains`.
10. Express registers the error handler.
11. `main.ts` initializes Elasticsearch observability indexes once for the process.
12. `main.ts` starts the analysis worker with `analysisJobService`.
13. `main.ts` starts the scheduler worker with `domainSchedulerService`.
14. `main.ts` starts the notification worker with `notificationService`.
15. `main.ts` ensures the repeatable scheduler tick job exists.
16. `app.listen()` opens the API port.
17. Shutdown handlers close the API, workers, queues, Redis, Postgres, and Elasticsearch clients.

Key files:

- `src/main.ts`
- `src/container.ts`
- `src/app.ts`
- `src/docs/openapi.ts`
- `src/modules/analysis/routes/analysis.routes.ts`
- `src/modules/providers/routes/provider-scores.routes.ts`
- `src/modules/visibility/routes/visibility-scores.routes.ts`

## API Request Flow

Health endpoint:

```http
GET /health
```

OpenAPI JSON endpoint:

```http
GET /openapi.json
```

Swagger UI endpoint:

```http
GET /docs
```

Analysis endpoint:

```http
POST /v1/analysis
```

Job polling endpoint:

```http
GET /v1/analysis/runs/:analysisRunId
```

Run diffs endpoint:

```http
GET /v1/analysis/runs/:analysisRunId/diffs
```

Schedule management endpoints:

```http
POST  /v1/schedules
GET   /v1/schedules
PATCH /v1/schedules/:scheduleId
```

Latest provider score endpoint:

```http
GET /v1/domains/:domainId/providers/:llmName/scores
```

Provider history endpoint:

```http
GET /v1/domains/:domainId/providers/:llmName/history
```

All provider comparison endpoint:

```http
GET /v1/domains/:domainId/provider-scores
```

Final visibility score endpoint:

```http
GET /v1/domains/:domainId/visibility-score
```

Visibility score history endpoint:

```http
GET /v1/domains/:domainId/visibility-score/history
```

Visibility score trend endpoint:

```http
GET /v1/domains/:domainId/visibility-score/trend
```

Example body:

```json
{
  "domain": "nike.com"
}
```

Call flow:

```text
analysis.routes.ts
  -> validateBody(requestSchema)
  -> BaseRouter.apiHandler(...)
  -> AnalysisController.handleAnalysisRequest(req)
  -> getClientIp(req)
  -> AnalysisCommandService.enqueueOrReturnCachedAnalysis(domain, ipAddress)
  -> return ApiResult
  -> sendApiResult(res, result)
```

Inside `enqueueOrReturnCachedAnalysis()`:

```text
normalizeDomain(rawDomain)
  -> check same-domain Redis rate limit
  -> Redis GET analysis:{domain}
  -> if cached, return cached visibility score
  -> upsertDomain(domain)
  -> findLatestVisibilityScore(domainId)
  -> if fresh score exists, cache and return it
  -> check unique-domain Redis rate limit
  -> else enqueue BullMQ job
```

Detailed behavior:

1. The request body is validated with Zod.
2. `BaseRouter.apiHandler(...)` awaits the controller and sends its `ApiResult`.
3. The controller logs the request, calls one service method, logs the response status, and returns the service result.
4. The input domain is normalized.
5. Redis same-domain spam protection is checked using IP + domain.
6. Redis cache is checked using key `analysis:{domain}`.
7. If Redis has a cached result, API returns `200`.
8. If Redis misses, PostgreSQL `domains` is upserted.
9. PostgreSQL `visibility_scores` is checked for latest score.
10. If the score exists and is fresh, it is cached in Redis and returned.
11. If missing or stale, Redis unique-domain rate limiting is checked.
12. If allowed, a BullMQ job is queued.
13. API returns `202 queued` with numeric `analysis_runs.id` as `analysis_run_id`, numeric `domains.id` as `domain_id`, and BullMQ infrastructure id as `bullmq_job_id`.

The client can then poll `GET /v1/analysis/runs/:analysisRunId`.

Polling behavior:

1. If the analysis run does not exist, return `404`.
2. If the analysis run is `queued` or `processing`, return `202 processing`.
3. If all providers failed, return `200 failed`.
4. If some providers failed and some succeeded, return `200 partial_success`.
5. If all providers succeeded, return `200 completed`.
6. Completed and partial-success responses include the latest `visibility_scores` row.
7. Run diffs can be read from `GET /v1/analysis/runs/:analysisRunId/diffs`.

Score read behavior:

1. `GET /v1/domains/:domainId/providers/:llmName/scores` returns one provider's latest top-k rows from `provider_analysis`.
2. `GET /v1/domains/:domainId/providers/:llmName/history` returns historical provider rows from `provider_snapshots`.
3. `GET /v1/domains/:domainId/provider-scores` returns OpenAI, Gemini, and Claude latest top-k rows from `provider_analysis`.
4. `GET /v1/domains/:domainId/visibility-score` returns the final aggregated latest score from `visibility_scores`.
5. `GET /v1/domains/:domainId/visibility-score/history` returns historical final scores from `visibility_scores`.
6. `GET /v1/domains/:domainId/visibility-score/trend` compares the latest and previous `visibility_scores` rows.
7. `GET /v1/analysis/runs/:analysisRunId/diffs` returns detected run-over-run changes from `analysis_diffs`.

Key files:

- `src/modules/analysis/routes/analysis.routes.ts`
- `src/modules/providers/routes/provider-scores.routes.ts`
- `src/modules/visibility/routes/visibility-scores.routes.ts`
- `src/modules/analysis/controllers/analysis.controller.ts`
- `src/modules/providers/controllers/provider-scores.controller.ts`
- `src/modules/visibility/controllers/visibility-scores.controller.ts`
- `src/modules/analysis/services/analysis-command.service.ts`
- `src/modules/analysis/services/analysis-status.service.ts`
- `src/modules/diffs/services/diff-engine.service.ts`
- `src/modules/providers/services/provider-scores.service.ts`
- `src/modules/visibility/services/visibility-score-read.service.ts`
- `src/queue/analysis.queue.ts`
- `src/repositories/domains.repository.ts`
- `src/modules/diffs/repositories/analysis-diffs.repository.ts`
- `src/modules/providers/repositories/provider-analysis.repository.ts`
- `src/modules/visibility/repositories/visibility-scores.repository.ts`

## Queue Laye

Queue name:

```text
domain-analysis
```

Additional queues:

```text
domain-schedule
analysis-notifications
```

Source:

```text
src/queue/analysis.queue.ts
src/queue/scheduler.queue.ts
src/queue/notification.queue.ts
```

Job data shape:

```ts
{
  analysisRunId: number;
  domainId: number;
  domain: string;
}
```

BullMQ does not run as its own server. It is a Node library that uses Redis.

## Worker Startup

Runtime entrypoint:

```text
src/main.ts
```

Call flow:

```text
main.ts
  -> createAnalysisWorker(analysisJobService)
  -> new Worker(ANALYSIS_QUEUE_NAME, handler)
  -> handler(job)
  -> analysisJobService.processAnalysisJob(job.data)
  -> createSchedulerWorker(domainSchedulerService)
  -> new Worker(SCHEDULER_QUEUE_NAME, handler)
  -> createNotificationWorker(notificationService)
  -> new Worker(NOTIFICATION_QUEUE_NAME, handler)
```

What happens:

1. Workers connect to Redis.
2. The analysis worker listens to the `domain-analysis` queue.
3. The scheduler worker listens to the `domain-scheduler` queue.
4. The notification worker listens to the `analysis-notifications` queue.
5. The analysis worker processes up to 3 jobs concurrently.
6. For each analysis job it calls `analysisJobService.processAnalysisJob()`.

Key files:

- `src/main.ts`
- `src/container.ts`
- `src/runtime/analysis-worker.ts`
- `src/runtime/scheduler-worker.ts`
- `src/runtime/notification-worker.ts`
- `src/modules/analysis/services/analysis-job.service.ts`
- `src/modules/scheduler/services/domain-scheduler.service.ts`
- `src/modules/notifications/services/notification.service.ts`

## Scheduler Flow

The scheduler uses a repeatable BullMQ job on `domain-scheduler`.

Call flow:

```text
ensureDomainSchedulerRepeatableJob()
  -> enqueue repeatable scan-due-domains job
  -> scheduler worker receives tick
  -> DomainSchedulerService.enqueueDueDomains()
  -> find enabled domain_schedules where next_run_at <= now()
  -> create analysis_runs row with source = scheduled
  -> enqueue domain-analysis job
  -> attach BullMQ job id to analysis_runs
  -> move domain_schedules.next_run_at forward by 7 days
```

Scheduled reruns are explicit. A domain must have a row in `domain_schedules`; the backend does not automatically schedule every analyzed domain.

## Job Processing Flow

Main service method:

```text
analysisJobService.processAnalysisJob(job)
```

Source:

```text
src/modules/analysis/services/analysis-job.service.ts
```

Call flow:

```text
analysisJobService.processAnalysisJob(job)
  -> mark analysis_runs processing
  -> Promise.allSettled(providerAdapters.map(executeProvider))
  -> persistProviderSuccess(...) for successful providers
  -> persistProviderFailure(...) for failed providers
  -> visibilityScoreService.calculateAndStoreVisibilityScore(domainId, analysisRunId)
  -> observabilityIndexService.indexProviderTraces(...)
  -> Redis SET analysis:{domain}
  -> mark analysis_runs completed / partial_success
  -> diffEngineService.calculateAndStoreDiffs(domainId, analysisRunId)
```

Important behavior:

1. The analysis run is marked `processing`.
2. Providers run in parallel.
3. `Promise.allSettled()` is used so one provider failure does not fail the whole workflow.
4. Successful provider results write completed rows.
5. Failed provider results write failed rows.
6. Aggregated GEO scoring happens after provider rows are written.
7. Elasticsearch indexing happens after aggregation.
8. Redis is updated with the final result.
9. Completed and partial-success runs calculate run-over-run diffs after the final status is stored.

## Provider Registry

Source:

```text
src/modules/providers/adapters/provider-registry.ts
```

Provider list:

```text
openai
gemini
claude
```

Current behavior:

```text
USE_MOCK_PROVIDERS=true
  -> use MockProviderAdapte

USE_MOCK_PROVIDERS=false
  -> use OpenAIProviderAdapte
  -> use GeminiProviderAdapte
  -> use AnthropicProviderAdapte
```

The mock adapter exists only to make the backend runnable without real LLM credentials. Real adapters make direct HTTP calls to each provider API and still return through the same `ProviderAdapter` interface.

For local provider-isolation testing, `ALLOW_MISSING_PROVIDER_KEYS=true` allows startup with only some API keys configured. Missing providers use `UnavailableProviderAdapter` and produce failed provider rows.

Key files:

- `src/config/constants.ts`
- `src/modules/providers/adapters/provider-registry.ts`
- `src/modules/providers/adapters/mock-provider-adapter.ts`
- `src/modules/providers/adapters/openai-provider-adapter.ts`
- `src/modules/providers/adapters/gemini-provider-adapter.ts`
- `src/modules/providers/adapters/anthropic-provider-adapter.ts`
- `src/modules/providers/adapters/unavailable-provider-adapter.ts`
- `src/types/provider.types.ts`

## Provider Execution Flow

Main function:

```text
executeProvider(adapter, domain)
```

Source:

```text
src/modules/providers/services/provider-execution.service.ts
```

Call flow:

```text
executeProvider(adapter, domain)
  -> buildRankingPrompt(domain)
  -> withRetries(adapter.runTextPrompt(rankingPrompt), PROVIDER_MAX_RETRIES)
  -> parseJsonObject(rankingResponse)
  -> buildObservabilityPrompt(domain)
  -> withRetries(adapter.runTextPrompt(observabilityPrompt), PROVIDER_MAX_RETRIES)
  -> for each top_k in [5, 10, 15, 50, 100]
       -> buildScoringPrompt(domain, top_k)
       -> withRetries(adapter.runTextPrompt(scoringPrompt), PROVIDER_MAX_RETRIES)
       -> parseJsonObject(scoringResponse)
  -> return provider execution result
```

`PROVIDER_MAX_RETRIES` defaults to `3`.

Prompts:

1. JSON ranking prompt
2. Full observability prompt
3. GEO scoring prompt for top 5
4. GEO scoring prompt for top 10
5. GEO scoring prompt for top 15
6. GEO scoring prompt for top 50
7. GEO scoring prompt for top 100

Key files:

- `src/modules/providers/services/provider-execution.service.ts`
- `src/prompts/geo.prompts.ts`
- `src/services/base.service.ts`

## PostgreSQL Write Flow

Successful provider result:

```text
persistProviderSuccess(...)
  -> upsertProviderAnalysis(...)
  -> insertProviderSnapshot(..., analysisRunId)
  -> prepare Elasticsearch trace document
```

Failed provider result:

```text
persistProviderFailure(...)
  -> upsertProviderAnalysis(status = failed)
  -> insertProviderSnapshot(status = failed, analysisRunId)
  -> prepare Elasticsearch failure trace document
```

Tables:

```text
domains
analysis_runs
provider_analysis
provider_snapshots
visibility_scores
analysis_diffs
```

Responsibilities:

- `analysis_runs`: async run status for frontend polling
- `provider_analysis`: latest provider + top-k state
- `provider_snapshots`: append-only provider + top-k history linked to `analysis_runs`
- `visibility_scores`: aggregated final GEO score linked to `analysis_runs`
- `analysis_diffs`: detected changes between the current successful run and previous successful run

Key files:

- `src/modules/diffs/services/diff-engine.service.ts`
- `src/modules/providers/repositories/provider-analysis.repository.ts`
- `src/modules/providers/repositories/provider-snapshots.repository.ts`
- `src/modules/visibility/repositories/visibility-scores.repository.ts`
- `src/modules/diffs/repositories/analysis-diffs.repository.ts`
- `src/db/migrations/001_initial_schema.sql`

Local migrations are reset-style. `npm run migrate` drops the known application tables and reapplies the current schema from `001_initial_schema.sql`; no backward-compatible migration chain is maintained for local development.

## SQL Query Registry

Application repository SQL lives in:

```text
src/db/sql-queries.ts
```

Repositories fetch SQL by key, for example `SQL_QUERIES.analysisRuns.findById`, and pass values separately through PostgreSQL parameter arrays. Route params, domains, provider names, limits, statuses, and JSON payloads must stay out of SQL string construction so PostgreSQL treats them as values, not executable SQL.

## Endpoint Smoke Test Flow

Command:

```bash
npm run test:endpoints
```

The smoke script owns its server lifecycle by default:

```text
scripts/test-endpoints.ts
  -> fail if API_BASE_URL already has a running /health response
  -> npm run build
  -> npm run migrate, unless RUN_MIGRATIONS=false
  -> Redis FLUSHDB for REDIS_URL, unless RESET_REDIS=false
  -> start dist/main.js
  -> wait for /health
  -> choose TEST_DOMAIN or the curated development domain list
  -> delete analysis:{domain} and age existing visibility_scores rows for each domain
  -> call docs, analysis, status, diffs, provider, visibility, and schedule endpoints for each domain
  -> stop the started server process
```

By default `REDIS_URL` is set to `redis://localhost:6379/15` inside the script so smoke-test queue, cache, and rate-limit state do not collide with normal local development. Curated domain mode uses a different synthetic `X-Forwarded-For` IP per domain unless `TEST_CLIENT_IP` is set. Set `USE_EXISTING_SERVER=true` only when intentionally testing an already-running API.

## Visibility Score Flow

Main service method:

```text
visibilityScoreService.calculateAndStoreVisibilityScore(domainId, analysisRunId)
```

Source:

```text
src/modules/visibility/services/visibility-score.service.ts
```

Call flow:

```text
visibilityScoreService.calculateAndStoreVisibilityScore(domainId, analysisRunId)
  -> providerAnalysisRepository.findLatestScoringRowsForDomain(domainId)
  -> filter completed latest provider_analysis rows
  -> calculate weighted provider scores
  -> calculate coverage score
  -> calculate mention frequency score
  -> calculate consistency score
  -> calculate overall GEO score
  -> insertVisibilityScore(..., analysisRunId)
```

Provider score formula:

```text
provider_score =
  top_5_score * 0.5
  + top_10_score * 0.3
  + top_50_score * 0.2
```

Only top 5, top 10, and top 50 are used for the current aggregate. Other stored top-k rows remain useful for observability and debugging.

Example:

```text
OpenAI top 5 score  = 0
OpenAI top 10 score = 0
OpenAI top 50 score = 65

openai_score =
  0 * 0.5
  + 0 * 0.3
  + 65 * 0.2
  = 13
```

Coverage score:

```text
providers_found / total_providers * 100
```

A provider counts as found when one of its weighted top-k rows has a positive score, a non-null rank, or mention count above zero.

Consistency score:

```text
best rank per provide
  -> calculate rank spread
  -> subtract spread penalty
  -> subtract missing provider penalty
```

Current implementation:

```text
consistency_score =
  max(0, 100 - min(100, rank_spread * 2) - missing_provider_count * 25)
```

Mention frequency score:

```text
min(100, total_mentions_across_weighted_rows * 10)
```

Current formula:

```text
overall_geo_score =
  average(provider_scores) * 0.6
  + coverage_score * 0.2
  + consistency_score * 0.1
  + mention_frequency_score * 0.1
```

This is intentionally simple for now. Do not add complicated ranking math until provider execution and observability are stable.

## Diff Engine Flow

Main service method:

```text
diffEngineService.calculateAndStoreDiffs(domainId, analysisRunId)
```

Source:

```text
src/modules/diffs/services/diff-engine.service.ts
```

Call flow:

```text
diffEngineService.calculateAndStoreDiffs(domainId, analysisRunId)
  -> find previous completed or partial_success analysis_run for the domain
  -> find current visibility_scores row by analysis_run_id
  -> find previous visibility_scores row by previous analysis_run_id
  -> find current provider_snapshots rows by analysis_run_id
  -> find previous provider_snapshots rows by previous analysis_run_id
  -> calculate visibility_score_dropped diffs
  -> calculate brand_rank_changed diffs
  -> calculate provider_mention_disappeared diffs
  -> calculate provider_recovered diffs
  -> insert analysis_diffs rows
```

Diffs are stored after completed and partial-success runs. Diff calculation failures are logged and do not change the completed analysis result.

Current diff types:

```text
visibility_score_dropped
brand_rank_changed
provider_mention_disappeared
provider_recovered
```

`new_competitor_appeared` is intentionally not implemented yet because competitor extraction is not stored as structured source-of-truth data.

## Notification Flow

Notifications are log-channel only for now. No email, Slack, webhook, or external delivery provider is added yet.

Call flow:

```text
AnalysisJobService.calculateDiffs(job)
  -> diffEngineService.calculateAndStoreDiffs(domainId, analysisRunId)
  -> NotificationService.enqueueDiffNotifications(diffs)
  -> insert notifications rows with status = pending
  -> enqueue analysis-notifications jobs
  -> notification worker receives job
  -> NotificationService.sendNotification(notificationId)
  -> console.log payload
  -> mark notification sent
```

Notification failures are isolated to the notification queue. They do not change the completed analysis result.

## Provider API Keys

Provider API keys come from environment variables:

```text
OPENAI_API_KEY
GEMINI_API_KEY
ANTHROPIC_API_KEY
```

Do not store provider API keys in PostgreSQL for this version. A database table for keys adds secret storage, encryption, auditing, and rotation complexity. For now, use `.env` locally and deployment secrets in production.

Operational rule:

```text
Rotate provider API keys at least every 3 months.
```

If this later becomes multi-tenant, key storage should be designed separately with encrypted secret storage or a cloud secrets manager, not added casually to the core analytics schema.

## Rate Limit Flow

Rate limiting uses Redis and runs before a new analysis job is created.

Request flow:

```text
POST /v1/analysis
  -> normalize domain
  -> check same-domain spam limit
  -> check Redis cache
  -> if cached, return cached result
  -> check PostgreSQL latest score freshness
  -> if fresh, cache and return result
  -> check unique-domain limit
  -> enqueue BullMQ job
```

Redis keys:

```text
rate_limit:same_domain:{ip}:{domain}
rate_limit:unique_domains:{ip}:{yyyy-mm-dd}
```

Defaults:

```text
same domain: 20 requests per IP/domain/hou
unique uncached domains: 5 domains per IP/day
```

Cached and fresh PostgreSQL results do not count against the unique-domain limit. Same-domain spam protection still applies before cache lookup.

## Elasticsearch Observability Flow

Main service method:

```text
observabilityIndexService.indexProviderTraces(documents)
```

Source:

```text
src/modules/observability/elasticsearch/elasticsearch-observability.service.ts
src/modules/observability/elasticsearch/observability-index-definitions.ts
```

Call flow:

```text
observabilityIndexService.indexProviderTraces(documents)
  -> Promise.allSettled(documents.map(indexProviderTrace))
  -> log failures if Elasticsearch is down
```

Operational event methods:

```text
observabilityIndexService.indexScheduledRun(document)
observabilityIndexService.indexNotification(document)
```

Indexes:

```text
openai-responses
gemini-responses
claude-responses
scheduled-runs
notifications
```

Important behavior:

Elasticsearch indexing is best-effort. If Elasticsearch is down, the worker, scheduler, or notification flow logs the failure but PostgreSQL workflow state still completes.

This is intentional because Elasticsearch is observability storage, not the structured source of truth.

Scheduled run documents are written when `DomainSchedulerService.enqueueDueDomains()` creates an `analysis_runs` row and enqueues the BullMQ analysis job. Notification documents are written when notifications are queued and when the log-channel notification worker marks them sent or failed.

Index setup is idempotent:

```text
ensureObservabilityIndexes()
  -> check openai-responses exists
  -> if exists, return
  -> else create it
  -> repeat for gemini-responses, claude-responses, scheduled-runs, and notifications
```

Within a running process, index setup is guarded by one shared promise and called during startup through `observabilityIndexService.initialize()`. Runtime API/worker calls reuse that startup result and do not re-check Elasticsearch indexes on every request.

## Cache Flow

Cache key:

```text
analysis:{domain}
```

Written by:

```text
analysisJobService.processAnalysisJob()
```

Read by:

```text
enqueueOrReturnCachedAnalysis()
```

Stored value:

```text
JSON.stringify(visibility_scores latest row)
```

Shape:

```json
{
  "id": 1,
  "domain_id": 1,
  "openai_score": "82.00",
  "gemini_score": "70.00",
  "claude_score": "90.00",
  "coverage_score": "100.00",
  "consistency_score": "92.00",
  "mention_frequency_score": "80.00",
  "overall_geo_score": "82.80",
  "created_at": "2026-05-14T..."
}
```

TTL:

```text
CACHE_TTL_SECONDS
```

Failed all-provider runs are not cached, because no `visibility_scores` row is created for them. Completed and partial-success runs are cached after the worker stores the final visibility score.

## History And Trend API

V4 history APIs reuse existing append-only/source tables. No schema change is required.

Visibility history:

```sql
SELECT *
FROM visibility_scores
WHERE domain_id = $1
ORDER BY created_at DESC
LIMIT 50;
```

Provider history:

```sql
SELECT *
FROM provider_snapshots
WHERE domain_id = $1
  AND llm_name = $2
ORDER BY created_at DESC
LIMIT 50;
```

Trend summary:

```text
current_score = latest visibility_scores.overall_geo_score
previous_score = previous visibility_scores.overall_geo_score
change = current_score - previous_score
trend =
  improved if change > 0
  dropped if change < 0
  stable if change = 0
  insufficient_history if there is no previous score
```

## Happy Path Summary

```text
1. node dist/main.js starts Express and the BullMQ workers
2. client POSTs domain to /v1/analysis
3. API validates domain
4. API checks same-domain Redis rate limit
5. API checks Redis cache
6. API checks PostgreSQL
7. API checks unique-domain Redis rate limit for uncached/stale domains
8. API enqueues BullMQ job
9. worker picks job
10. worker marks analysis_runs processing
11. worker runs openai, gemini, claude adapters in parallel
12. each provider runs ranking, observability, and scoring prompts
13. worker writes provider_analysis latest rows
14. worker writes provider_snapshots history rows
15. worker calculates visibility_scores row
16. worker indexes Elasticsearch trace documents
17. worker caches final result in Redis
18. next API request returns cached or PostgreSQL result
```

## Current Local Caveats

- Providers are mocked while `USE_MOCK_PROVIDERS=true`.
- Real OpenAI, Gemini, and Claude HTTP adapters are used while `USE_MOCK_PROVIDERS=false`.
- Elasticsearch may be absent locally. That is acceptable for now.
