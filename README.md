# GEO V6 Production Core Backend

This branch contains the Phase 1 database foundation for GEO V6. The HTTP runtime remains a clean backend shell; no V5 business modules or placeholder analysis APIs are active.

## Implemented in Phase 1

- Production-safe, ordered PostgreSQL migrations
- Frozen 26-table Production Core schema
- Database enums, foreign keys, ownership and hierarchy constraints
- Idempotency constraints and practical indexes
- Immutable evidence/output guards
- TypeScript row contracts for all 26 tables
- PostgreSQL integration tests for migration safety and schema invariants

The migration ledger is stored outside the production table namespace in `geo_meta.schema_migrations`. Applied migrations are protected by SHA-256 checksums and run one-at-a-time under a PostgreSQL advisory lock. Each migration runs in its own transaction.

The runner intentionally refuses to initialize a non-empty `public` schema. Existing prototype/reset schemas must be handled explicitly rather than silently modified or destroyed.

## Active HTTP Surface

```text
GET /health
GET /openapi.json
GET /docs
```

`/health` confirms that the API process is running. It is not a PostgreSQL, Redis, or Elasticsearch readiness check.

## Local Setup

Copy `.env.example` to `.env`, install dependencies, and start infrastructure:

```bash
npm install
npm run infra:up
npm run migrate
npm run dev
```

`npm run migrate` is repeatable. Once the schema is current, another run is a no-op.

## Verification

Run the regular checks:

```bash
npm run typecheck
npm test
npm run build
```

Run PostgreSQL migration integration tests against the isolated test service:

```bash
npm run infra:test:up
npm run test:migrations
npm run infra:test:down
```

`test:migrations` waits up to 30 seconds for PostgreSQL readiness, so this sequence is safe to run immediately after a cold container start. The integration suite destroys and recreates schemas only in a database whose name ends in `_test`. It verifies incremental application, no-op reruns, preservation of existing rows, the exact table set, ownership and hierarchy constraints, idempotency, immutable provider evidence, and checksum drift rejection.

## Phase Boundary

Phase 1 implements only migration and database type foundations. It does not add:

- Business APIs or application services
- RabbitMQ, publishers, consumers, or workers
- Provider integrations
- Analysis orchestration, scoring, or report generation

Those belong to later approved phases.
