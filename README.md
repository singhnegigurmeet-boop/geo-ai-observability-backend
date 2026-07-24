# GEO V6 Production Core Backend

This branch contains the Phase 4 transactional analysis-submission slice for GEO V6. PostgreSQL remains authoritative. The API can accept an owned starting hierarchy path, create a queued `analysis_run`, and atomically create its `analysis_run.created` outbox event.

## Implemented

- Production-safe PostgreSQL migrations and the frozen 26-table schema
- PostgreSQL outbox-to-RabbitMQ delivery infrastructure
- Opaque user and anonymous sessions with workspace ownership
- Strict hostname-like domain normalization
- Active DB-controlled hierarchy validation
- Exact entity-path create/reuse
- Owner-scoped, normalized-request idempotency
- Transactional `analysis_runs` and `outbox_events` creation
- Owner-scoped queued-run status reads

The Phase 4 API does not create `analysis_run_items`. Hierarchy expansion belongs to a future `analysis_run_worker`.

## HTTP Surface

```text
GET  /health
GET  /openapi.json
GET  /docs
POST /v1/analysis
GET  /v1/analysis/runs/:analysisRunId
```

Health and documentation are public. Both analysis routes mount ownership middleware locally and require either:

```text
X-Anonymous-Session-Token: <anonymous-token>
```

or:

```text
Authorization: Bearer <user-token>
X-Workspace-Id: <workspace-id>
```

A validated claimed submission may also send the anonymous token with the user credentials. The recorded anonymous origin is preserved only when its claim matches that user and workspace.

## Submit an Analysis

`POST /v1/analysis` requires a client-generated idempotency key:

```text
Idempotency-Key: <stable-client-key>
```

Example body:

```json
{
  "domain": "example.com",
  "categoryId": "1",
  "brandId": "2"
}
```

The hierarchy must be contiguous:

```text
domain
domain -> category
domain -> category -> brand
domain -> category -> brand -> product
domain -> category -> brand -> product -> use_context
```

The API may create the normalized domain and exact selected `entity_path`. It never creates category, brand, product, or use-context master records. Deeper relationships must already be represented by active database-controlled paths.

An accepted or idempotently replayed request returns `202`:

```json
{
  "analysisRunId": "42",
  "startingEntityPathId": "9",
  "status": "queued",
  "idempotentReplay": false,
  "createdAt": "2026-07-24T10:00:00.000Z"
}
```

Reusing a key for the same owner and normalized request returns the existing run. Reusing it for a different normalized request returns `409 CONFLICT`. The same client key may be used independently by another owner.

## Reliable Handoff

The run and outbox event are written in one PostgreSQL transaction:

```text
analysis_runs
  + outbox_events (analysis_run.created)
  -> COMMIT
```

The event is routed through `analysis_run_queue` and contains only run, path, and ownership identifiers. RabbitMQ transports the event; future workers must reload authoritative state from PostgreSQL.

## Local Setup

Copy `.env.example` to `.env`, set a private `SESSION_TOKEN_PEPPER`, then:

```bash
npm install
npm run infra:up
npm run migrate
npm run dev
```

Run the outbox dispatcher separately when delivery is needed:

```bash
npm run outbox:dev
```

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Integration suites:

```bash
npm run infra:test:up
npm run test:migrations
npm run test:phase2
npm run test:phase3
npm run test:phase4
npm run infra:test:down
```

Integration launchers wait for their dependencies. Destructive test schema setup is guarded by a `_test` database suffix.

## Not Implemented

- RabbitMQ business consumers
- `analysis_run_worker` or `analysis_run_items` expansion
- LLM runs or prompt jobs
- Provider jobs, execution, or results
- Budget enforcement
- Scoring or reports
- Scheduler or notification execution
