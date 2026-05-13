# Backend Execution Flow

This document explains how the backend starts, which functions are called, and what each layer does.

## Runtime Process

The backend runs as one combined process.

Start command:

```bash
npm start
```

This starts:

1. API server
2. BullMQ worker

in the same Node process and shuts both down together.

The API and worker still communicate through BullMQ, which stores queue state in Redis.

PostgreSQL, Redis, BullMQ queue, Elasticsearch, repositories, provider adapters, and core services are created once at startup and reused. Request handlers and job handlers should not create new infrastructure objects.

```text
HTTP client
  -> API process
  -> Redis / PostgreSQL lookup
  -> BullMQ job
  -> Worker process
  -> Provider execution
  -> PostgreSQL writes
  -> analysis_runs status update
  -> Elasticsearch trace indexing
  -> Redis cache write
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
  -> createApp(analysisApiService)
  -> createAnalysisWorker(analysisJobService)
  -> app.listen(env.PORT)
```

What happens:

1. `main.ts` imports wired services from `src/container.ts`.
2. `main.ts` imports `createApp` from `src/app.ts`.
3. `createApp(analysisApiService)` builds the Express app.
4. Express registers JSON parsing.
5. Express registers `GET /health`.
6. Express registers `/v1/analysis`.
7. Express registers `/v1/domains`.
8. Express registers the error handler.
9. `main.ts` starts the BullMQ worker with `analysisJobService`.
10. `app.listen()` opens the API port.
11. Shutdown handlers close the API, worker, Redis, Postgres, and Elasticsearch clients.

Key files:

- `src/main.ts`
- `src/container.ts`
- `src/app.ts`
- `src/routes/analysis.routes.ts`

## API Request Flow

Endpoint:

```http
POST /v1/analysis
```

Job polling endpoint:

```http
GET /v1/analysis/jobs/:jobId
```

Latest provider score endpoint:

```http
GET /v1/domains/:domainId/providers/:llmName/scores
```

All provider comparison endpoint:

```http
GET /v1/domains/:domainId/provider-scores
```

Final visibility score endpoint:

```http
GET /v1/domains/:domainId/visibility-score
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
  -> requestSchema.parse(req.body)
  -> enqueueOrReturnCachedAnalysis(domain)
```

Inside `enqueueOrReturnCachedAnalysis()`:

```text
normalizeDomain(rawDomain)
  -> Redis GET analysis:{domain}
  -> upsertDomain(domain)
  -> findLatestVisibilityScore(domainId)
  -> if fresh score exists, cache and return it
  -> else enqueue BullMQ job
```

Detailed behavior:

1. The request body is validated with Zod.
2. The input domain is normalized.
3. Redis is checked first using key `analysis:{domain}`.
4. If Redis has a cached result, API returns `200`.
5. If Redis misses, PostgreSQL `domains` is upserted.
6. PostgreSQL `visibility_scores` is checked for latest score.
7. If the score exists and is fresh, it is cached in Redis and returned.
8. If missing or stale, a BullMQ job is queued.
9. API returns `202 queued` with numeric `analysis_runs.id` as `job_id` and numeric `domains.id` as `domain_id`.

The client can then poll `GET /v1/analysis/jobs/:jobId`.

Polling behavior:

1. If the job does not exist, return `404`.
2. If the analysis run is `queued` or `processing`, return `202 processing`.
3. If all providers failed, return `200 failed`.
4. If some providers failed and some succeeded, return `200 partial_success`.
5. If all providers succeeded, return `200 completed`.
6. Completed and partial-success responses include the latest `visibility_scores` row.

Score read behavior:

1. `GET /v1/domains/:domainId/providers/:llmName/scores` returns one provider's latest top-k rows from `provider_analysis`.
2. `GET /v1/domains/:domainId/provider-scores` returns OpenAI, Gemini, and Claude latest top-k rows from `provider_analysis`.
3. `GET /v1/domains/:domainId/visibility-score` returns the final aggregated latest score from `visibility_scores`.

Key files:

- `src/routes/analysis.routes.ts`
- `src/services/analysis-api.service.ts`
- `src/queue/analysis.queue.ts`
- `src/repositories/domains.repository.ts`
- `src/repositories/provider-analysis.repository.ts`
- `src/repositories/visibility-scores.repository.ts`

## Queue Layer

Queue name:

```text
domain-analysis
```

Source:

```text
src/queue/analysis.queue.ts
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
```

What happens:

1. Worker connects to Redis.
2. Worker listens to the `domain-analysis` queue.
3. Worker processes up to 3 jobs concurrently.
4. For each job it calls `analysisJobService.processAnalysisJob()`.

Key files:

- `src/main.ts`
- `src/container.ts`
- `src/runtime/analysis-worker.ts`
- `src/services/analysis-job.service.ts`

## Job Processing Flow

Main service method:

```text
analysisJobService.processAnalysisJob(job)
```

Source:

```text
src/services/analysis-job.service.ts
```

Call flow:

```text
analysisJobService.processAnalysisJob(job)
  -> Promise.allSettled(providerAdapters.map(executeProvider))
  -> persistProviderSuccess(...) for successful providers
  -> persistProviderFailure(...) for failed providers
  -> visibilityScoreService.calculateAndStoreVisibilityScore(domainId)
  -> observabilityIndexService.indexProviderTraces(...)
  -> Redis SET analysis:{domain}
```

Important behavior:

1. Providers run in parallel.
2. `Promise.allSettled()` is used so one provider failure does not fail the whole workflow.
3. Successful provider results write completed rows.
4. Failed provider results write failed rows.
5. Aggregated GEO scoring happens after provider rows are written.
6. Elasticsearch indexing happens after aggregation.
7. Redis is updated with the final result.

## Provider Registry

Source:

```text
src/providers/provider-registry.ts
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
  -> use MockProviderAdapter

USE_MOCK_PROVIDERS=false
  -> use OpenAIProviderAdapter
  -> use GeminiProviderAdapter
  -> use AnthropicProviderAdapter
```

The mock adapter exists only to make the backend runnable without real LLM credentials. Real adapters make direct HTTP calls to each provider API and still return through the same `ProviderAdapter` interface.

For local provider-isolation testing, `ALLOW_MISSING_PROVIDER_KEYS=true` allows startup with only some API keys configured. Missing providers use `UnavailableProviderAdapter` and produce failed provider rows.

Key files:

- `src/config/constants.ts`
- `src/providers/provider-registry.ts`
- `src/providers/mock-provider-adapter.ts`
- `src/providers/openai-provider-adapter.ts`
- `src/providers/gemini-provider-adapter.ts`
- `src/providers/anthropic-provider-adapter.ts`
- `src/providers/unavailable-provider-adapter.ts`
- `src/types/provider.types.ts`

## Provider Execution Flow

Main function:

```text
executeProvider(adapter, domain)
```

Source:

```text
src/services/provider-execution.service.ts
```

Call flow:

```text
executeProvider(adapter, domain)
  -> buildRankingPrompt(domain)
  -> withRetries(adapter.runTextPrompt(rankingPrompt), 3)
  -> parseJsonObject(rankingResponse)
  -> buildObservabilityPrompt(domain)
  -> withRetries(adapter.runTextPrompt(observabilityPrompt), 3)
  -> for each top_k in [5, 10, 15, 50, 100]
       -> buildScoringPrompt(domain, top_k)
       -> withRetries(adapter.runTextPrompt(scoringPrompt), 3)
       -> parseJsonObject(scoringResponse)
  -> return provider execution result
```

Prompts:

1. JSON ranking prompt
2. Full observability prompt
3. GEO scoring prompt for top 5
4. GEO scoring prompt for top 10
5. GEO scoring prompt for top 15
6. GEO scoring prompt for top 50
7. GEO scoring prompt for top 100

Key files:

- `src/services/provider-execution.service.ts`
- `src/prompts/geo.prompts.ts`
- `src/services/base.service.ts`

## PostgreSQL Write Flow

Successful provider result:

```text
persistProviderSuccess(...)
  -> upsertProviderAnalysis(...)
  -> insertProviderSnapshot(...)
  -> prepare Elasticsearch trace document
```

Failed provider result:

```text
persistProviderFailure(...)
  -> upsertProviderAnalysis(status = failed)
  -> insertProviderSnapshot(status = failed)
  -> prepare Elasticsearch failure trace document
```

Tables:

```text
domains
analysis_runs
provider_analysis
provider_snapshots
visibility_scores
```

Responsibilities:

- `analysis_runs`: async run status for frontend polling
- `provider_analysis`: latest provider + top-k state
- `provider_snapshots`: append-only provider + top-k history
- `visibility_scores`: aggregated final GEO score

Key files:

- `src/repositories/provider-analysis.repository.ts`
- `src/repositories/provider-snapshots.repository.ts`
- `src/repositories/visibility-scores.repository.ts`
- `src/db/migrations/001_initial_schema.sql`

## Visibility Score Flow

Main service method:

```text
visibilityScoreService.calculateAndStoreVisibilityScore(domainId)
```

Source:

```text
src/services/visibility-score.service.ts
```

Call flow:

```text
visibilityScoreService.calculateAndStoreVisibilityScore(domainId)
  -> providerSnapshotsRepository.findLatestProviderSnapshots(domainId)
  -> filter completed snapshots
  -> average provider scores
  -> calculate coverage score
  -> calculate mention frequency score
  -> calculate consistency score
  -> calculate overall GEO score
  -> insertVisibilityScore(...)
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

## Elasticsearch Trace Flow

Main service method:

```text
observabilityIndexService.indexProviderTraces(documents)
```

Source:

```text
src/services/observability-index.service.ts
```

Call flow:

```text
observabilityIndexService.indexProviderTraces(documents)
  -> Promise.allSettled(documents.map(indexProviderTrace))
  -> log failures if Elasticsearch is down
```

Indexes:

```text
openai-responses
gemini-responses
claude-responses
```

Important behavior:

Elasticsearch indexing is best-effort. If Elasticsearch is down, the worker logs the failure but the PostgreSQL scoring workflow still completes.

This is intentional because Elasticsearch is observability storage, not the structured source of truth.

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

TTL:

```text
CACHE_TTL_SECONDS
```

## Happy Path Summary

```text
1. node dist/main.js starts Express and the BullMQ worker
2. client POSTs domain to /v1/analysis
3. API validates domain
4. API checks Redis
5. API checks PostgreSQL
6. API enqueues BullMQ job
7. worker picks job
8. worker runs openai, gemini, claude adapters in parallel
9. each provider runs ranking, observability, and scoring prompts
10. worker writes provider_analysis latest rows
11. worker writes provider_snapshots history rows
12. worker calculates visibility_scores row
13. worker indexes Elasticsearch trace documents
14. worker caches final result in Redis
15. next API request returns cached or PostgreSQL result
```

## Current Local Caveats

- Providers are mocked while `USE_MOCK_PROVIDERS=true`.
- Real OpenAI, Gemini, and Claude HTTP adapters are used while `USE_MOCK_PROVIDERS=false`.
- Elasticsearch may be absent locally. That is acceptable for now.
