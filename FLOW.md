# Phase 0 Runtime Flow

The active branch is a clean GEO V6 backend shell. There is no active V5 business flow and no placeholder V6 analysis flow.

## Startup

```text
src/main.ts
  -> load validated environment
  -> import shared PostgreSQL, Redis, and Elasticsearch clients
  -> create Express app
  -> listen on configured port
```

No migrations, index setup, queue declaration, scheduler, provider call, or worker startup occurs.

## HTTP Routes

```text
GET /health
GET /openapi.json
GET /docs
```

All previous analysis, discovery, provider, visibility, diff, schedule, and notification routes are absent.

## Shutdown

```text
SIGINT or SIGTERM
  -> stop accepting HTTP requests
  -> close Redis client
  -> close PostgreSQL pool
  -> close Elasticsearch client
```

## Data Layer Quarantine

These files remain solely so Phase 1 can replace them atomically:

```text
src/db/migrate.ts
src/db/migrations/001_initial_schema.sql
src/db/sql-queries.ts
src/types/database.types.ts
src/config/constants.ts
```

They contain a reset-style prototype schema, are not the frozen 26-table schema, and must not be executed. No package or Docker migration command exposes them.

## Explicitly Not Implemented

- V6 business APIs
- Identity or workspace ownership
- Production migrations
- RabbitMQ
- Outbox publisher
- Queues or workers
- LLM runs or prompt jobs
- Provider jobs or results
- Budget enforcement
- Token usage
- Backend scoring
- Reports
- Notifications
- Scheduler jobs

Those capabilities belong to later approved phases.
