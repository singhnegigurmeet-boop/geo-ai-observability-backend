# GEO V6 Production Core

GEO V6 is a production-oriented backend for running owned, hierarchy-aware
generative-engine-observability analyses. PostgreSQL is the authoritative
business store. RabbitMQ carries asynchronous aggregate IDs. A transactional
outbox joins database state changes to broker publication without dual writes.

Provider output is immutable evidence. Scoring and reports are backend-owned
interpretations of that evidence.

## Implemented V6

- Anonymous sessions, users, workspaces, memberships, and session claims
- Domain/category/brand/product/use-context hierarchy validation and expansion
- Owner-scoped, canonical, idempotent analysis submission
- Frozen multi-provider sets with bounded validation and stable ordering
- Logical prompt planning, rendering, and per-provider/model fan-out
- Deterministic mock execution plus gated OpenAI, Gemini, and Claude adapters
- Hierarchical budget admission, reservation, and actual-usage reconciliation
- Immutable provider results, scores, and partial/final report revisions
- Terminal failure propagation, retries, DLQs, cancellation, and notifications
- UTC interval scheduler with authorization and hierarchy revalidation
- Health, exact-schema readiness, OpenAPI, structured logs, and Compose runtime

There is no provider race and no fallback. Every configured provider/model job
executes independently. A logical `prompt_job` is complete only when all of its
provider children are terminal.

## Architecture

```text
HTTP / scheduler
  -> analysis_run
  -> frozen requested categories
  -> optional domain-category classification
  -> analysis_run_items
  -> llm_runs
  -> prompt_jobs
  -> provider_jobs
  -> provider_results
  -> provider_scores
  -> immutable report revisions
```

Every asynchronous transition writes an `outbox_events` row in the same
transaction as its business state. The dispatcher publishes a minimal,
ID-oriented event. Workers reload and lock PostgreSQL state, making duplicate
and out-of-order delivery safe.

The source layout follows feature modules:

```text
src/
  modules/<domain>/
    routes/ controllers/ services/ repositories/
    types/ policies/ workers/ adapters/
  common/       # shared database, messaging, middleware, ownership, and types
  utils/        # reusable pure helpers
tests/
  unit/<domain>/
  integration/<domain>/
  e2e/<domain>/
```

Only folders needed by a module are present. Composition roots remain in
`src/app.ts`, `src/container.ts`, and the module `entrypoints` folders.

Final event payloads are:

| Event | Payload |
| --- | --- |
| `analysis_run.created` | `analysisRunId` |
| `domain_category_classification.created` | `classificationJobId` |
| `domain_category_classification_result.created` | `providerResultId` |
| `analysis_run_item.created` | `analysisRunItemId` |
| `llm_run.created` | `llmRunId` |
| `prompt_job.created` | `promptJobId` |
| `provider_job.created` | `providerJobId` |
| `provider_result.created` | `providerResultId` |
| `notification.created` | `notificationId` |

## Schema

An empty database is bootstrapped by one migration:
`src/common/database/migrations/001_v6_final_baseline.sql`. It directly creates the final
34-table schema, 26 enums, constraints, indexes, functions, and triggers.

The tables cover:

- identity: `users`, `user_sessions`, `anonymous_sessions`
- workspaces: `workspaces`, `workspace_members`, `workspace_role_requests`
- hierarchy: masters, relationship tables with classification provenance, and
  `entity_paths`
- analysis: `analysis_runs`, frozen requested categories, classification jobs,
  frozen provider models, and items
- execution: `llm_runs`, `prompt_jobs`, `provider_jobs`, `provider_results`
- interpretation: `provider_scores`, immutable `reports`
- limits/usage: `budget_policies`, `token_usage`
- reliability/operations: `failure_records`, `outbox_events`,
  `scheduler_jobs`, and `notifications`

Relationship tables are hierarchy truth; `entity_paths` are materialized paths.
Frozen provider-set rows, provider results, scores, token usage, and report
snapshots are protected by database invariants.

## Ownership and hierarchy

Requests use either:

- `X-Anonymous-Session-Token`
- `Authorization: Bearer <user-session-token>` with `X-Workspace-Id`
- both forms for a claimed-session request

Claimed users gain derived access only to analyses created by the exact claimed
anonymous session. Workspace access always requires current membership.

Submission validates the complete active relationship chain. Expansion is
deterministic: anonymous runs select up to three active children; user and valid
claimed runs select up to five. A path cannot override invalid relationship
truth.

## Provider sets and idempotency

Anonymous requests always use `mock/mock-fast` and cannot provide a provider
set. Logged-in and claimed requests default to `mock/mock-standard`.
`providerModels` may contain one to four supported pairs for user work.

The provider-set policy validates ownership of provider/model pairs,
deduplicates and stably sorts them, serializes them into canonical request
identity, and freezes them per run. Real pairs require
`ENABLE_REAL_PROVIDERS=true` and their matching API key.

## Evidence, budgets, scoring, and reports

Budget policies may apply at platform, workspace, user, anonymous-session,
analysis-run, provider, or exact-model scope. Admission reserves estimated
usage under locks; successful execution reconciles to actual usage exactly
once. A budget pause is a business outcome, not a technical failure.

A successful upstream response can be valid evidence, a valid refusal, or
invalid evidence. Invalid evidence is terminal and unscored. Transport and
configuration failures are technical failures, not invalid evidence.

Valid visibility and ranking results receive immutable, metric-specific scores.
Competitor, price, and pros-and-cons results are diagnostic evidence and do not
receive generic numeric scores. Reports are immutable snapshots. New meaningful
evidence creates a new revision; deep-equal state does not. Reports expose
classification and provider/model provenance plus honest pending, valid,
invalid, failed, paused, cancelled, or never-materialized coverage. Missing or
failed evidence is never converted to numeric zero.

Final report outcomes include completed, completed-empty, failed-empty,
budget-paused partial, cancelled-empty, and reachable cancelled-partial states.

## Reliability, cancellation, scheduler, and notifications

Retryable worker failures are recorded and republished with broker confirmation.
Exhausted or permanent failures record terminal history, terminalize the
addressed business state, recalculate parents, create an applicable report and
notification, and route the message to the DLQ. A DLQ is transport history, not
business truth.

Cancellation is allowed only before provider execution starts. It propagates to
unstarted descendants and is idempotent; once provider execution has begun it
returns a conflict.

The scheduler supports UTC interval schedules. Each due tick is claimed
concurrently with database locking, revalidates the current user, workspace,
membership, hierarchy, and provider set, then enters the same analysis service
as a manual request.

Notifications are internal records delivered by the notification worker.
External email, SMS, and push delivery are not implemented.

## Local setup

Requirements: Node.js 24+, Docker with Compose, PostgreSQL 16, and RabbitMQ 4.

```bash
npm install
copy .env.example .env
npm run infra:test:up
npm run migrate
npm run dev
```

The migration command uses `DATABASE_URL`. Never point test commands at a
database whose name does not end in `_test`.

For the full default runtime:

```bash
npm run docker:up
```

This starts PostgreSQL and RabbitMQ, applies the final baseline through the
one-shot `migrate` service, then starts the API, outbox dispatcher, analysis
workers, classification and classification-result workers, LLM worker, prompt
worker, mock provider worker, scoring worker, scheduler, and notification
worker. All application processes wait for a successful bootstrap.
Real-provider workers are opt-in:

```bash
docker compose --profile real-providers up -d --build
```

Individual process scripts are available in `package.json`, including
`outbox:start`, `analysis-worker:start`, `analysis-item-worker:start`,
`classification-worker:start`, `classification-result-worker:start`,
`llm-run-worker:start`, `prompt-worker:start`, provider-worker scripts,
`scoring-worker:start`, `scheduler-worker:start`, and `notification-worker:start`.

## Testing

```bash
npm run typecheck
npm run test:unit
npm run test:schema
npm run test:integration
npm run test:e2e
npm run test:e2e:full
npm run test:all
npm run build
npm run verify
```

`test:e2e` is the deterministic release gate. `test:e2e:full` additionally
runs high-contention budgets, scheduler/outbox contention, retry exhaustion,
process-restart recovery, RabbitMQ outage recovery, and repeated deadlock
regressions. The full profile is intentionally excluded from `verify` because
it is slower and disruptive by design; `verify` includes the standard E2E gate.

## HTTP API

- `POST /v1/analysis/preview` — run the same canonical planner as creation,
  returning honest classification/path/job uncertainty, exact frozen models,
  bounded token/cost estimates, safety-limit decisions, and a canonical hash
  without creating business rows

- `GET /health` — process liveness
- `GET /ready` — PostgreSQL, exact baseline ledger, RabbitMQ, queues, and DLQs
- `POST /v1/analysis` — submit an owned analysis
- `GET /v1/analysis/runs/:analysisRunId` — owner-scoped lifecycle status
- `GET /v1/analysis/runs/:analysisRunId/report` — latest report revision
- `POST /v1/analysis/runs/:analysisRunId/cancel` — pre-execution cancellation
- `GET /docs` — Swagger UI

Readiness never calls an external provider. Public DTOs do not expose provider
raw bodies, upstream raw errors, credentials, session secrets, or broker
metadata.

Reports use `geo-scoring-v2` and the immutable
`multi-provider-geo-report-v3` contract. Category and exact-model coverage is
derived from the frozen expected execution set. Diagnostic sections consolidate
only validated evidence with deterministic ordering and bounded output; usage
shows the frozen planning estimate beside actual telemetry and missing telemetry
counts.

## Scope boundaries

### Implemented V6

The production core described above is implemented and tested.

### Deferred V6.5

- Redis
- Elasticsearch
- market and country scope
- additional product polish and dynamic policies
- advanced provider comparisons
- external notification delivery
- richer scheduling

### Future V7+

Global scope, crawlers, RAG, agents, frontend, payments/billing, provider racing
or fallback, and microservice extraction are outside this repository.
