# GEO AI Observability Backend

Production-oriented backend for domain-only GEO visibility analysis across multiple LLM providers.

This project is intentionally focused on backend infrastructure:

- Express API
- PostgreSQL structured analytics
- Redis caching
- BullMQ async job orchestration
- Elasticsearch prompt/response observability
- Raw SQL repositories
- Provider-isolated execution
- Constructor-based dependency wiring from `src/container.ts`
- Shared contracts in `src/types`

It is not a chatbot, prompt playground, dashboard, vector search app, or recommendation engine.

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
  -> Worker
  -> Parallel provider execution
  -> PostgreSQL provider_analysis latest state
  -> PostgreSQL provider_snapshots history
  -> PostgreSQL visibility_scores aggregate score
  -> Elasticsearch provider trace documents
  -> Redis final result cache
```

Provider failures are isolated. One failed provider should not fail the full workflow.

## Data Stores

PostgreSQL is the structured source of truth.

- `domains`: unique analyzed domains
- `provider_analysis`: latest provider/top-k scoring state
- `provider_snapshots`: append-only provider/top-k historical scoring
- `visibility_scores`: final aggregated GEO scores
- `analysis_runs`: async run status for frontend polling

Elasticsearch is for observability only.

- `openai-responses`
- `gemini-responses`
- `claude-responses`

For index setup and search examples, see [ELASTICSEARCH.md](./ELASTICSEARCH.md).

Redis is used for:

- BullMQ queue state
- final analysis result cache

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

The local `.env` currently uses:

```env
NODE_ENV=development
PORT=4000
DATABASE_URL=postgres://geo_user:geo_pass_123@localhost:5432/geo_observability
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_NODE=http://localhost:9200
CACHE_TTL_SECONDS=3600
ANALYSIS_STALE_HOURS=24
USE_MOCK_PROVIDERS=true
ALLOW_MISSING_PROVIDER_KEYS=false
PROVIDER_TIMEOUT_MS=60000
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-3-5-haiku-latest
```

Do not commit real provider API keys when real adapters are added.

## Provider Modes

Mock mode:

```env
USE_MOCK_PROVIDERS=true
```

This uses deterministic local provider responses from `src/providers/mock-provider-adapter.ts`.

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

## Build And Typecheck

```bash
npm test
npm run typecheck
npm run build
```

## Run The API And Worker

Recommended single-command runtime:

```bash
cd /mnt/d/geo-ai-observability-backend
npm run build
npm start
```

This starts the API and BullMQ worker in the same Node process. When the process receives `Ctrl+C` or `SIGTERM`, it closes the HTTP server, worker, Redis connection, PostgreSQL pool, and Elasticsearch client.

Health check:

```bash
curl http://127.0.0.1:4000/health
```

Expected:

```json
{"status":"ok"}
```

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
  "job_id": 1,
  "domain_id": 1,
  "bullmq_job_id": "1",
  "message": "Analysis started",
  "domain": "nike.com"
}
```

Run the same request again after a few seconds. It should return the stored score from PostgreSQL or Redis.

Or poll the job directly:

```bash
curl http://127.0.0.1:4000/v1/analysis/jobs/1
```

Use the numeric `job_id` returned by the submit endpoint, not the internal `bullmq_job_id`.

Possible job responses:

```json
{
  "status": "processing",
  "job_id": 1,
  "domain": "nike.com",
  "run_status": "processing"
}
```

```json
{
  "status": "partial_success",
  "job_id": 1,
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
  "job_id": 1,
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
npm run migrate      # apply raw SQL migrations
npm run elasticsearch:setup # create Elasticsearch observability indexes
npm run typecheck    # TypeScript check
npm run build        # compile to dist
npm start            # run compiled API and worker together
```

Docker scripts are present, but Docker was not available in the current WSL environment:

```bash
npm run infra:up
npm run infra:down
npm run docker:migrate
npm run docker:up
npm run docker:logs
```

## Important Notes

- BullMQ is not a separate server. It is an npm package and uses Redis.
- PostgreSQL remains the business source of truth.
- Elasticsearch is not the ranking engine.
- `provider_snapshots` should remain append-only.
- `provider_analysis` stores latest provider/top-k state.
- `visibility_scores` stores final aggregate GEO scoring.
- Provider responses are deterministic mocks only when `USE_MOCK_PROVIDERS=true`.
- Real adapters use direct HTTP calls through the existing provider interface.

## Stop Local Processes

If you started the compiled app manually:

```bash
pkill -f 'node dist/main.js'
```
