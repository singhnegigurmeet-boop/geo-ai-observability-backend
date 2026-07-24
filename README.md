# GEO V6 Production Core Backend

This branch contains the Phase 2 infrastructure and reliability core for GEO V6. PostgreSQL remains authoritative, and a standalone dispatcher delivers committed `outbox_events` to RabbitMQ. The HTTP runtime remains a health/docs shell with no business APIs.

## Implemented

- Production-safe PostgreSQL migrations and the frozen 26-table schema
- `geo_meta.schema_migrations` checksum ledger
- Durable RabbitMQ main and dead-letter exchanges
- All 13 frozen queues and a dedicated technical DLQ for each queue
- Typed ID-oriented queue envelopes
- Persistent mandatory publishing with broker confirms
- Transactional outbox claiming with `FOR UPDATE SKIP LOCKED`
- Lease-based stale-dispatch recovery
- Confirmed success transitions and database-owned retry backoff
- Standalone dispatcher startup and graceful shutdown

Outbox delivery is intentionally at least once. If a process loses its connection after RabbitMQ accepts a message but before PostgreSQL records success, the event can be republished after its lease expires. Future consumers must handle the unique envelope `messageId` idempotently and reload authoritative state from PostgreSQL.

## Active HTTP Surface

```text
GET /health
GET /openapi.json
GET /docs
```

`/health` confirms only that the API process is running.

## Local Setup

Copy `.env.example` to `.env`, install dependencies, start infrastructure, and migrate:

```bash
npm install
npm run infra:up
npm run migrate
```

Start the HTTP shell and outbox dispatcher in separate terminals:

```bash
npm run dev
npm run outbox:dev
```

The dispatcher declares RabbitMQ topology on connection. It does not create outbox events or execute business work.

## Verification

Run regular checks:

```bash
npm run typecheck
npm test
npm run build
```

Run migration integration tests:

```bash
npm run infra:test:up
npm run test:migrations
npm run infra:test:down
```

Run Phase 2 PostgreSQL/RabbitMQ integration tests:

```bash
npm run infra:test:up
npm run test:phase2
npm run infra:test:down
```

Both integration launchers wait up to 30 seconds for required infrastructure. Test schema resets are guarded by a `_test` database-name suffix.

## Phase Boundary

Phase 2 implements message transport and outbox delivery only. It does not add:

- Analysis or other business APIs
- RabbitMQ business consumers
- Analysis, prompt, provider, scheduler, or notification workers
- Provider integrations
- Scoring or report generation
