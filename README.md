# GEO AI Observability Backend

Production-oriented backend for domain-only GEO visibility analysis across multiple LLM providers.

This project is intentionally focused on backend infrastructure:

- Express API
- PostgreSQL structured analytics
- Redis caching
- BullMQ async job orchestration
- Elasticsearch prompt/response observability
- Raw SQL repositories
- Central SQL query registry in `src/db/sql-queries.ts`
- Provider-isolated execution
- Constructor-based dependency wiring from `src/container.ts`
- Shared contracts in `src/types`

It is not a chatbot, prompt playground, dashboard, vector search app, or recommendation engine.

The codebase is a modular monolith. It stays one app and one deployment unit while domain code is grouped under `src/modules/*`:

```text
src/modules/
  analysis/
    controllers/
    routes/
    services/
    repositories/
  providers/
    controllers/
    routes/
    services/
    repositories/
    adapters/
  visibility/
    controllers/
    routes/
    services/
    repositories/
  diffs/
    services/
    repositories/
  scheduler/
    services/
    repositories/
  notifications/
    services/
    repositories/
  observability/
    services/
```

Workers can become separate processes later if needed, but they should continue sharing this codebase and domain model until there is a concrete reason to split services.

## Core Terms

- **Domain**: The website being analyzed, for example `nike.com`.
- **Analysis**: One request to evaluate a domain's visibility across OpenAI, Gemini, and Claude.
- **Analysis run**: A tracked execution row in `analysis_runs`. The frontend polls this with `analysis_run_id`.
- **Job**: A BullMQ queue item stored in Redis. The API returns quickly while the worker processes the job in the background.
- **Worker**: Code that listens to a queue and performs background work. The current app starts the API, analysis worker, scheduler worker, and notification worker in one Node process.
- **Provider**: One LLM source: `openai`, `gemini`, or `claude`.
- **Provider analysis**: Latest provider/top-k result for a domain, stored in `provider_analysis`.
- **Provider snapshot**: Historical provider/top-k result for a specific run, stored in `provider_snapshots`.
- **Visibility score**: Final aggregate GEO score for a domain/run, stored in `visibility_scores`.
- **Diff**: A detected change between the current run and the previous successful run, stored in `analysis_diffs`.
- **Observability trace**: Prompt/response debugging data written to Elasticsearch. It is not used as the ranking source of truth.

## Module Responsibilities

- `analysis`: Owns analysis request routing, job status polling, analysis run state, queue enqueueing, and worker orchestration.
- `providers`: Owns provider adapters, provider prompt execution, provider latest scores, and provider history reads.
- `visibility`: Owns aggregate visibility score calculation and visibility score read APIs.
- `diffs`: Owns run-over-run change detection and `analysis_diffs` persistence.
- `scheduler`: Owns recurring due-domain scans and scheduled analysis enqueueing.
- `notifications`: Owns notification records and the log-channel notification worker.
- `observability`: Owns Elasticsearch index setup and best-effort provider trace indexing.
- Shared `src/repositories/domains.repository.ts`: Owns the cross-module `domains` table.
- Shared `src/services/rate-limit.service.ts`: Owns Redis-backed request rate limits.

## Current Status

The backend is runnable locally with deterministic mock providers or real provider APIs.

Mock providers let the full API, Redis, BullMQ, worker, PostgreSQL, and scoring pipeline run without paid LLM credentials. Real OpenAI, Gemini, and Claude adapters are available behind the same provider interface.

Elasticsearch is optional for the current local run. If Elasticsearch is not running, trace indexing logs a failure, but PostgreSQL scoring still completes.

## Architecture Flow

For a function-by-function startup and execution walkthrough, see [FLOW.md](./FLOW.md).

```text
API
  -> Redis cache lookup
  -> PostgreSQL latest score lookup
  -> BullMQ job enqueue when missing or stale
  -> Worke
  -> analysis_runs processing update
  -> Parallel provider execution
  -> PostgreSQL provider_analysis latest state
  -> PostgreSQL provider_snapshots history
  -> PostgreSQL visibility_scores aggregate score
  -> Elasticsearch provider trace documents
  -> Redis final result cache
  -> analysis_runs final status update
  -> analysis_diffs run-over-run changes
  -> notifications log-channel jobs for detected diffs
```

Provider failures are isolated. One failed provider should not fail the full workflow.

## Data Stores

PostgreSQL is the structured source of truth.

- `domains`: unique analyzed domains
- `provider_analysis`: latest provider/top-k scoring state
- `provider_snapshots`: append-only provider/top-k historical scoring
- `visibility_scores`: final aggregated GEO scores
- `analysis_runs`: async run status for frontend polling
- `analysis_diffs`: detected run-over-run changes after completed or partial-success runs
- `domain_schedules`: explicit weekly rerun schedules for domains
- `notifications`: pending/sent/failed notification records for detected diffs

Elasticsearch is for observability only.

- `openai-responses`
- `gemini-responses`
- `claude-responses`
- `scheduled-runs`
- `notifications`

For index setup and search examples, see [ELASTICSEARCH.md](./ELASTICSEARCH.md).

Elasticsearch index names and mappings live in `src/modules/observability/elasticsearch/observability-index-definitions.ts`. The server prepares these indexes once during startup; runtime writes are best-effort observability events.

Redis is used for:

- BullMQ queue state
- final analysis result cache
- analysis request rate limiting

BullMQ queues:

- `domain-analysis`: runs domain analyses.
- `domain-scheduler`: scans `domain_schedules` for due reruns.
- `analysis-notifications`: sends log-channel notifications for diffs.

## Requirements

Tested from WSL:

- Node.js
- npm
- PostgreSQL running on `localhost:5432`
- Redis running on `localhost:6379`

Optional:

- Elasticsearch on `localhost:9200`
- Docker / Docker Desktop WSL integration

## Environment

The local `.env` file is **not committed** to version control for security. Copy `.env.example` to `.env` and update the values:

```bash
cp .env.example .env
```

Then edit `.env` with your configuration:

```env
NODE_ENV=development
PORT=4000
DATABASE_URL=postgres://geo_user:geo_pass_123@localhost:5432/geo_observability
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_NODE=http://localhost:9200

CACHE_TTL_SECONDS=3600
ANALYSIS_STALE_HOURS=24
PROVIDER_TIMEOUT_MS=60000
PROVIDER_MAX_RETRIES=3
SCHEDULER_TICK_MS=60000

USE_MOCK_PROVIDERS=true
ALLOW_MISSING_PROVIDER_KEYS=false

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash

ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-3-5-haiku-latest
```

**Important:** The `.env` file is ignored by Git (see `.gitignore`). Never commit real API keys or sensitive credentials.

Provider API keys should come from environment variables or deployment secrets:

```env
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
```

Do not store provider API keys in PostgreSQL in this version. Rotate real provider keys at least every 3 months.

## Provider Modes

Mock mode:

```env
USE_MOCK_PROVIDERS=true
```

This uses deterministic local provider responses from `src/modules/providers/adapters/mock-provider-adapter.ts`.

Real provider mode:

```env
USE_MOCK_PROVIDERS=false
OPENAI_API_KEY=your_openai_key
GEMINI_API_KEY=your_gemini_key
ANTHROPIC_API_KEY=your_anthropic_key
```

All three keys are required when mock mode is disabled. If one key is missing, the app fails fast at startup instead of running in a confusing half-real state.

OpenAI-only local test mode:

```env
USE_MOCK_PROVIDERS=false
ALLOW_MISSING_PROVIDER_KEYS=true
OPENAI_API_KEY=your_openai_key
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
```

In this mode OpenAI runs for real, while Gemini and Claude are recorded as failed providers. This is useful for testing provider isolation, but production should use all provider keys.

## Install

From WSL:

```bash
cd /mnt/d/geo-ai-observability-backend
npm install
```

## Test PostgreSQL

Check Postgres is available:

```bash
pg_isready -h localhost -p 5432
```

Check project database login:

```bash
PGPASSWORD='geo_pass_123' psql -h localhost -U geo_user -d geo_observability -c 'select current_user, current_database();'
```

List tables:

```bash
PGPASSWORD='geo_pass_123' psql -h localhost -U geo_user -d geo_observability -c '\dt'
```

Check row counts:

```bash
PGPASSWORD='geo_pass_123' psql -h localhost -U geo_user -d geo_observability -c '
select count(*) as domains from domains;
select count(*) as provider_analysis from provider_analysis;
select count(*) as provider_snapshots from provider_snapshots;
select count(*) as visibility_scores from visibility_scores;
select count(*) as analysis_diffs from analysis_diffs;
'
```

## Test Redis

```bash
redis-cli ping
```

Expected:

```text
PONG
```

## Run Migrations

```bash
npm run migrate
```

Local migrations are reset-style. The command drops the known application tables, recreates the current schema from `src/db/migrations/001_initial_schema.sql`, and verifies the required tables. This project does not preserve backward-compatible migration history during local development.

## Build And Typecheck

```bash
npm test
npm run typecheck
npm run build
```

## Run The API And Workers

For a clean checkout:

```bash
cd /mnt/d/geo-ai-observability-backend
npm install
npm run migrate
npm run build
npm start
```

This starts the API plus the analysis, scheduler, and notification BullMQ workers in the same Node process. When the process receives `Ctrl+C` or `SIGTERM`, it closes the HTTP server, workers, BullMQ queues, Redis connection, PostgreSQL pool, and Elasticsearch client.

Health check:

```bash
curl http://127.0.0.1:4000/health
```

Expected:

```json
{"status":"ok"}
```

## API Documentation

Swagger UI is served by the API process:

```bash
curl http://127.0.0.1:4000/openapi.json
```

Open the interactive docs at:

```text
http://127.0.0.1:4000/docs
```

## API Reference

### `GET /health`

Checks whether the Express API process is running.

Typical response:

```json
{"status":"ok"}
```

### `GET /openapi.json`

Returns the OpenAPI specification used by Swagger UI. Use this for API clients, docs tooling, or quick route inspection.

### `GET /docs`

Serves Swagger UI for interactive API exploration in the browser.

### `POST /v1/analysis`

Starts or retrieves analysis for a domain.

What it does:

1. Validates the request body.
2. Normalizes the domain.
3. Checks same-domain Redis rate limit.
4. Checks Redis cache.
5. Checks the latest PostgreSQL visibility score.
6. Checks unique-domain Redis rate limit if the domain is uncached/stale.
7. Creates an `analysis_runs` row and enqueues a BullMQ job when fresh data is unavailable.

Possible outcomes:

- `200`: existing cached or fresh PostgreSQL result returned.
- `202`: new analysis job queued.
- `400`: invalid body.
- `429`: rate limited.

### `GET /v1/analysis/jobs/:jobId`

Polls an analysis run by numeric `analysis_runs.id`.

What it returns:

- `202 processing` while the run is queued or processing.
- `200 completed` when all providers succeeded.
- `200 partial_success` when at least one provider succeeded and at least one failed.
- `200 failed` when all providers failed.
- `404` when the job id does not exist.

Completed and partial-success responses include the latest `visibility_scores` row.

### `GET /v1/analysis/jobs/:jobId/diffs`

Returns run-over-run changes detected for one analysis job.

Diffs are calculated after a completed or partial-success run by comparing it to the previous completed or partial-success run for the same domain.

Current diff types:

- `visibility_score_dropped`
- `brand_rank_changed`
- `provider_mention_disappeared`
- `provider_recovered`

### `GET /v1/domains/:domainId/providers/:llmName/scores`

Returns the latest top-k score rows for one provider from `provider_analysis`.

Allowed `llmName` values:

- `openai`
- `gemini`
- `claude`

Use this when the frontend needs the latest provider-specific state.

### `GET /v1/domains/:domainId/providers/:llmName/history`

Returns historical provider/top-k rows from `provider_snapshots`.

Use this when the frontend needs provider history, run history, or debugging information over time.

### `GET /v1/domains/:domainId/provider-scores`

Returns the latest provider comparison across OpenAI, Gemini, and Claude from `provider_analysis`.

Use this for side-by-side provider score comparison.

### `GET /v1/domains/:domainId/visibility-score`

Returns the latest aggregate GEO visibility score from `visibility_scores`.

Use this as the main final score endpoint for a domain.

### `GET /v1/domains/:domainId/visibility-score/history`

Returns historical aggregate visibility score rows from `visibility_scores`.

Use this to plot score history over time.

### `GET /v1/domains/:domainId/visibility-score/trend`

Compares the latest and previous visibility scores.

Trend values:

- `improved`
- `dropped`
- `stable`
- `insufficient_history`

## Scheduler And Notifications

The scheduler and notification workers run inside the same Node process for now. They are separate BullMQ workers, not microservices.

Scheduler behavior:

1. A repeatable BullMQ job runs on `domain-scheduler`.
2. Each tick scans enabled rows in `domain_schedules` where `next_run_at <= now()`.
3. For every due schedule, it creates an `analysis_runs` row with `source = scheduled`.
4. It enqueues a normal `domain-analysis` job.
5. It moves that schedule's `next_run_at` forward by 7 days.

Notification behavior:

1. The analysis worker runs the diff engine after completed or partial-success runs.
2. If diffs are detected, notification records are inserted into `notifications`.
3. Jobs are enqueued on `analysis-notifications`.
4. The notification worker currently uses only the `log` channel and marks notifications as `sent`.

Enable a weekly schedule manually:

```sql
INSERT INTO domain_schedules (domain_id, cadence, enabled, next_run_at)
VALUES (1, 'weekly', true, now())
ON CONFLICT (domain_id)
DO UPDATE SET enabled = true, next_run_at = excluded.next_run_at, updated_at = now();
```

This intentionally requires an explicit schedule row. The backend does not automatically rerun every analyzed domain.

## Submit Analysis

```bash
curl -X POST http://127.0.0.1:4000/v1/analysis \
  -H "Content-Type: application/json" \
  -d '{"domain":"nike.com"}'
```

First response usually returns:

```json
{
  "status": "queued",
  "analysis_run_id": 1,
  "domain_id": 1,
  "bullmq_job_id": "analysis-run-1-1778841898167",
  "message": "Analysis started",
  "domain": "nike.com"
}
```

If rate limited, the API returns `429`:

```json
{
  "status": "rate_limited",
  "error": "Same domain request limit exceeded",
  "limit": 20,
  "current": 21,
  "retry_after_seconds": 3600
}
```

Run the same request again after a few seconds. It should return the stored score from PostgreSQL or Redis.

Or poll the job directly:

```bash
curl http://127.0.0.1:4000/v1/analysis/jobs/1
```

Use the numeric `analysis_run_id` returned by the submit endpoint, not the internal `bullmq_job_id`.

Read detected run-over-run diffs for a job:

```bash
curl http://127.0.0.1:4000/v1/analysis/jobs/1/diffs
```

Diffs currently cover:

- `visibility_score_dropped`
- `brand_rank_changed`
- `provider_mention_disappeared`
- `provider_recovered`

Possible job responses:

```json
{
  "status": "processing",
  "analysis_run_id": 1,
  "domain": "nike.com",
  "run_status": "processing"
}
```

```json
{
  "status": "partial_success",
  "analysis_run_id": 1,
  "domain": "nike.com",
  "providers": {
    "openai": { "status": "completed", "error_message": null },
    "gemini": { "status": "failed", "error_message": "provider error" },
    "claude": { "status": "completed", "error_message": null }
  },
  "data": {
    "overall_geo_score": "42.10"
  }
}
```

```json
{
  "status": "failed",
  "analysis_run_id": 1,
  "domain": "nike.com",
  "error": "Analysis failed. All providers failed after retries."
}
```

## Read Domain Scores

Score read routes are separate from `POST /v1/analysis`.

Single provider scores read from `provider_analysis`, the latest-state table:

```bash
curl "http://127.0.0.1:4000/v1/domains/1/providers/openai/scores"
```

Allowed provider names:

- `openai`
- `gemini`
- `claude`

Example response:

```json
{
  "status": "found",
  "source": "provider_analysis",
  "domain_id": 1,
  "domain": "nike.com",
  "provider": "openai",
  "scores": [
    {
      "top_k": 5,
      "rank_position": 2,
      "mention_count": 3,
      "score": "92.00",
      "status": "completed",
      "error_message": null
    }
  ]
}
```

All provider comparison also reads from `provider_analysis`:

```bash
curl "http://127.0.0.1:4000/v1/domains/1/provider-scores"
```

Final aggregated GEO score reads from `visibility_scores`:

```bash
curl "http://127.0.0.1:4000/v1/domains/1/visibility-score"
```

## Inspect Results

Latest GEO scores:

```bash
PGPASSWORD='geo_pass_123' psql -h localhost -U geo_user -d geo_observability -c '
select d.domain, v.openai_score, v.gemini_score, v.claude_score, v.overall_geo_score, v.created_at
from visibility_scores v
join domains d on d.id = v.domain_id
order by v.created_at desc
limit 10;
'
```

Provider latest state:

```bash
PGPASSWORD='geo_pass_123' psql -h localhost -U geo_user -d geo_observability -c '
select d.domain, p.llm_name, p.top_k, p.rank_position, p.mention_count, p.score, p.status, p.last_run
from provider_analysis p
join domains d on d.id = p.domain_id
order by p.llm_name, p.top_k;
'
```

Historical snapshots:

```bash
PGPASSWORD='geo_pass_123' psql -h localhost -U geo_user -d geo_observability -c '
select d.domain, s.llm_name, s.top_k, s.score, s.status, s.created_at
from provider_snapshots s
join domains d on d.id = s.domain_id
order by s.created_at desc
limit 20;
'
```

## Scripts

```bash
npm run dev          # API and worker in one process with tsx watch
npm run migrate      # reset local app tables and apply the current raw SQL schema
npm run elasticsearch:setup # create Elasticsearch observability indexes
npm run test:endpoints # reset local state, start the API, and smoke test HTTP endpoints
npm run typecheck    # TypeScript check
npm run build        # compile to dist
npm start            # run compiled API and worker togethe
```

Endpoint smoke test:

```bash
npm run test:endpoints
```

The script builds the project, optionally runs migrations, flushes the selected Redis database, starts `dist/main.js`, waits for `/health`, submits `POST /v1/analysis`, polls the returned `analysis_run_id`, and then calls every read endpoint. It stops the server process that it started when the smoke test finishes.

By default the smoke test uses `REDIS_URL=redis://localhost:6379/15` so test queue/cache/rate-limit state is isolated from normal local development. It also refuses to reuse an already-running API at `API_BASE_URL`; stop the old process first so the script can start the current build. Set `USE_EXISTING_SERVER=true` only when intentionally testing a server you started yourself.

Useful options:

```bash
RUN_MIGRATIONS=false npm run test:endpoints
RESET_REDIS=false npm run test:endpoints
TEST_DOMAIN=nike.com npm run test:endpoints
SHOW_RESPONSES=false npm run test:endpoints
MAX_RESPONSE_CHARS=8000 npm run test:endpoints
```

By default the script runs the curated website set: Nike, Adidas, Puma, Apple, Samsung, Sony, Figma, Notion, Slack, HubSpot, Salesforce, Shopify, Stripe, Airbnb, and Booking. Set `TEST_DOMAIN=nike.com` to run one domain. Before each domain is submitted, the script clears `analysis:{domain}` from Redis and ages any existing visibility score so repeated dev runs create new history for trend/diff checks.

Docker scripts are present, but Docker was not available in the current WSL environment:

```bash
npm run infra:up
npm run infra:down
npm run docker:migrate
npm run docker:up
npm run docker:logs
```

## Important Notes

- Markdown files are the project source of truth. Any architecture, route, workflow, scoring, database, cache, queue, or provider behavior change must update the relevant `.md` file in the same change.
- BullMQ is not a separate server. It is an npm package and uses Redis.
- PostgreSQL remains the business source of truth.
- Elasticsearch is not the ranking engine.
- `provider_snapshots` should remain append-only.
- `provider_analysis` stores latest provider/top-k state.
- `visibility_scores` stores final aggregate GEO scoring.
- `analysis_diffs` stores detected changes between run-linked histories.
- `new_competitor_appeared` is intentionally not implemented until competitor data is stored structurally.
- Provider responses are deterministic mocks only when `USE_MOCK_PROVIDERS=true`.
- Real adapters use direct HTTP calls through the existing provider interface.

## Stop Local Processes

If you started the compiled app manually:

```bash
pkill -f 'node dist/main.js'
```
