# GEO V6 Production Core Backend

This branch contains the Phase 6 LLM-run control-unit slice for GEO V6. PostgreSQL remains authoritative. The API creates a queued run, Phase 5 expands it into concrete items, and Phase 6 creates exactly one LLM planning/control unit per item.

## Implemented

- Production-safe PostgreSQL migrations and the current 30-table schema
- PostgreSQL outbox-to-RabbitMQ delivery infrastructure
- Opaque user and anonymous sessions with workspace ownership
- Hostile-input-safe public ASCII domain normalization
- Explicit active hierarchy-relationship validation
- Exact entity-path create/reuse
- Owner-scoped, normalized-request idempotency
- Transactional `analysis_runs` and `outbox_events` creation
- Owner-scoped queued-run status reads
- One-level `analysis_run_worker` expansion through explicit relationships
- Transactional `analysis_run_items` and `analysis_run_item.created` outbox events
- PostgreSQL idempotency, bounded worker retries, failure history, and DLQ routing
- One `llm_run` per queued `analysis_run_item`
- Transactional `llm_run.created` ID-only outbox events
- Shared reliable RabbitMQ consumer runtime for both business workers

The Phase 4 API still does not create `analysis_run_items`; only the Phase 5 worker does. Phase 6 consumes those item events and does not create prompts or select providers/models.

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

The domain field accepts a bare hostname or HTTP(S) URL-like value. The input boundary removes protocol, credentials-free port, path, query, hash, a leading `www.`, and then validates the extracted public ASCII hostname. Instruction-like text, HTML/script-like input, IDNs/punycode, IP literals, localhost, and internal/reserved host suffixes are rejected.

Only the normalized hostname is persisted in `domains`, `analysis_runs.request_payload`, and downstream status data. Raw domain input is never included in outbox messages or retained as `display_domain`.

The original V6 core schema contained 26 public production tables. Phase 4.5 adds four relationship tables—`domain_categories`, `category_brands`, `brand_products`, and `product_use_contexts`—for a current total of 30.

Categories, brands, products, and use contexts are controlled master records. The relationship tables define valid cascade relationships using IDs only. `entity_paths` materializes reusable concrete paths for analysis state and is not relationship authority.

Normal analysis submission may create/reuse normalized domains and exact selected `entity_paths`. It never creates category, brand, product, or use-context masters, and it never creates relationship rows. Those relationships are admin/system/discovery-controlled.

Hierarchy expansion reads active relationship rows in deterministic admin-controlled order: `sort_order ASC NULLS LAST`, then relationship creation time and relationship ID. Anonymous runs select at most three children; logged-in and claimed runs select at most five. A full use-context path creates one direct item.

Any future crawler or fetcher must additionally resolve and revalidate every destination IP at request time and after redirects. Input normalization alone is not a complete SSRF boundary.

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

The event is routed through `analysis_run_queue` and contains only run, path, and ownership identifiers. RabbitMQ transports the event; the worker reloads authoritative state from PostgreSQL.

The worker locks a queued run and atomically materializes child paths, creates queued items, emits one ID-only `analysis_run_item.created` event per item, and moves the run to `processing`. A path with no eligible children becomes `failed` with `NO_EXPANSION_CHILDREN`; this is acknowledged as a business outcome rather than dead-lettered.

Technical failures roll back the expansion and are recorded in `failure_records`. Consumer attempts are tracked separately from outbox publication attempts. Attempts one and two are confirmed-republished; attempt three is rejected to `analysis_run_queue.dlq`.

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

Run the Phase 5 consumer separately:

```bash
npm run analysis-worker:dev
```

Run the Phase 6 item consumer separately:

```bash
npm run analysis-item-worker:dev
```

Phase 6 consumes `analysis_run_item.created`, locks the queued item, validates its parent run, path, and ownership against PostgreSQL, creates/reuses one queued `llm_run` with `run_key = primary`, and emits `llm_run.created` to `llm_run_queue`. The item then moves to `processing`; the parent analysis run is not completed or otherwise updated.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

`npm run typecheck` performs full semantic TypeScript checking for both
`src/**/*.ts` and `tests/**/*.ts`. The test suite is not considered type-safe
merely because `tsx` can execute it.

Integration suites:

```bash
npm run infra:test:up
npm run test:migrations
npm run test:phase2
npm run test:phase3
npm run test:phase4
npm run test:phase45
npm run test:phase5
npm run test:phase6
npm run infra:test:down
```

Integration launchers wait for their dependencies. Destructive test schema setup is guarded by a `_test` database suffix.

## Not Implemented

- Prompt jobs, rendering, templates, or prompt/model policy
- Provider jobs, execution, or results
- Budget enforcement
- Scoring or reports
- Scheduler or notification execution
- Redis cache, rate limiting, locks, or deduplication
- Country, market, or global-scope expansion
