# GEO V6 Production Core Backend

This branch is currently a Phase 0 clean backend shell.

The V5 prototype and the earlier V6 placeholder runtime have been removed from active source. No analysis, discovery, provider, scoring, reporting, scheduling, notification, queue, or worker feature is currently exposed.

## Active HTTP Surface

```text
GET /health
GET /openapi.json
GET /docs
```

`/health` confirms only that the API process is running. It is not a PostgreSQL, Redis, or Elasticsearch readiness check.

## Retained Infrastructure

- Express application bootstrap
- Environment validation with Zod
- PostgreSQL pool and transaction helper
- Redis client
- Elasticsearch client
- Generic controller, router, repository, validation, error, and API response helpers
- Docker Compose services for PostgreSQL, Redis, and Elasticsearch

RabbitMQ has not been added. There are no queue publishers, consumers, workers, provider integrations, or V6 business modules in Phase 0.

## Quarantined Phase 1 Files

The following legacy reset-style migration files are intentionally retained unchanged for atomic replacement in Phase 1:

```text
src/db/migrate.ts
src/db/migrations/001_initial_schema.sql
src/db/sql-queries.ts
src/types/database.types.ts
src/config/constants.ts
```

They do not represent the frozen 26-table Production Core schema. Do not execute them against a database. Migration commands have been removed from `package.json` and Docker Compose during quarantine.

## Local Setup

Copy `.env.example` to `.env` and install dependencies:

```bash
npm install
```

Start optional local infrastructure:

```bash
npm run infra:up
```

Run the shell:

```bash
npm run dev
```

Verify it:

```bash
curl http://127.0.0.1:4000/health
```

Expected response:

```json
{"status":"ok"}
```

## Verification

```bash
npm run typecheck
npm test
npm run build
```

## Phase Boundaries

Phase 0 removes conflicting prototype behavior and leaves a buildable shell.

Phase 1 will replace the quarantined migration system with the frozen production schema. It must not incrementally modify the quarantined reset schema.

Later phases will introduce RabbitMQ, outbox delivery, workers, mock providers, scoring, reports, and other frozen V6 components in their approved implementation order.
