# GEO V6 Production Core

GEO V6 is a modular TypeScript backend for submitting hierarchy-scoped analyses, executing each logical prompt across an immutable provider/model set, and producing backend-scored, revisioned reports.

PostgreSQL is the source of truth. RabbitMQ is transport. The transactional outbox is the reliable handoff between them. Provider responses are evidence; scoring and reporting remain backend-owned.

## Runtime architecture

The repository is one modular codebase with independently runnable API and worker processes:

```text
HTTP API
  -> PostgreSQL transaction + outbox
  -> outbox dispatcher
  -> RabbitMQ
  -> analysis -> item -> LLM -> prompt -> provider -> scoring workers
  -> report revisions + notification outbox
```

Workers receive aggregate-ID messages, reload and lock authoritative rows, make idempotent transitions, and write downstream outbox events in the same transaction. A shared lifecycle service derives parent state from provider jobs through prompt jobs, LLM runs, run items, analysis runs, and report readiness.

## Database

Migrations `001`–`024` create 31 production tables:

- Identity and ownership: `users`, user/anonymous sessions, workspaces, memberships, and role-change requests.
- Hierarchy: domains, four master levels, four relationship tables, and materialized `entity_paths`.
- Execution: analysis runs and items, frozen run provider sets, LLM runs, prompts, provider jobs, and immutable provider results.
- Budgets and interpretation: budget policies, token usage, immutable provider scores, and immutable report revisions.
- Operations: outbox events, failure records, notifications, and scheduler jobs.

Foreign keys, checks, uniqueness, immutable-row triggers, provider-set freezing, report revision rules, operational notification rules, and query indexes are enforced in PostgreSQL. Multiple `llm_runs.run_key` values and prompt versions remain supported.

## Ownership and hierarchy

An analysis is owned in one of three ways:

- Anonymous session.
- User plus workspace membership.
- User/workspace with a validated claimed anonymous origin.

Claiming does not rewrite historical anonymous runs. The exact claimant receives derived access to pre-claim runs; unrelated users, workspaces, and anonymous sessions remain denied. The same ownership predicate protects status, report, and cancellation reads.

Hierarchy relationship tables are authoritative; `entity_paths` are materialized paths only. Every selected master and edge must be active and the path must be contiguous. Manual submissions and scheduled runs share this validation. Expansion follows deterministic administrator ordering and selects at most three children for anonymous work or five for user/claimed work.

## Analysis and provider-set identity

`POST /v1/analysis` requires `Idempotency-Key` and an ownership session. A minimal body is:

```json
{ "domain": "example.com" }
```

A user or claimed request may choose up to four exact provider/model pairs:

```json
{
  "domain": "example.com",
  "providerModels": [
    { "provider": "mock", "model": "mock-quality" },
    { "provider": "openai", "model": "gpt-4o-mini" }
  ]
}
```

Provider sets are validated, deduplicated, stably sorted, serialized canonically, and frozen on the run. Order and duplicates do not alter idempotency identity. Reusing an owner-scoped key with a different normalized request conflicts.

Defaults are:

- Anonymous: `mock/mock-fast`.
- User or claimed: `mock/mock-standard`.

Deprecated `preferredProvider`/`preferredModel` fields remain as single-pair HTTP compatibility. They cannot be combined with `providerModels`. Real providers are feature-gated and use only the exact configured OpenAI, Gemini, or Claude model.

## Prompts and independent provider execution

Planning creates logical `prompt_jobs`; rendering renders each logical prompt once. Fan-out creates one `provider_job` and one outbox event for every frozen run provider/model pair:

```text
one prompt_job
  -> many provider_jobs
  -> one provider_result per provider job
  -> one provider_score per result and scoring version
```

Providers execute independently. This is parallel fan-out, not racing, and there is no fallback. One successful sibling cannot complete a prompt while another sibling remains executable.

Budget policies may apply at platform, workspace, user, anonymous-session, or run scope, optionally by provider/model. Estimated token/cost reservations use PostgreSQL locks. Actual usage is reconciled once. Hard limits block before crossing; soft limits allow one crossing execution. A budget pause acknowledges work without technical retry, failure record, or DLQ, and preserves completed evidence.

Valid provider results are immutable evidence and become inputs to deterministic `backend-v1` scoring. Malformed successful responses are retained as immutable invalid evidence, remain unscored, and appear as coverage gaps. Valid refusals remain valid evidence. Failed, invalid, paused, cancelled, or absent evidence is never converted to numeric zero.

## Reports, failures, and cancellation

Reports are immutable `multi-provider-v2` revisions. The latest revision may represent:

- `partial`
- `budget_paused_partial`
- `completed`
- `completed_with_gaps`
- `failed_empty`
- `cancelled_partial`
- `cancelled_empty`
- `completed_empty`

Valid sibling scores are averaged equally at the logical-prompt level. Provider/model provenance, coverage state, usage, invalid evidence, failures, cancellation, pauses, and pending work remain distinct.

Retryable technical failures are confirmed-republished for attempts one and two. Permanent or exhausted work records the failure, terminalizes the addressed aggregate, recalculates parents, creates any ready report and notification, then rejects to the queue's DLQ. DLQ state is operational evidence, not business state.

Cancellation is allowed only before provider execution begins. It cancels queued descendants transactionally; delayed messages become successful no-ops. Late cancellation conflicts and does not create retries, failure records, or DLQ traffic.

An expansion with no eligible child completes normally with `completed_empty`.

## Scheduler and notifications

The scheduler supports UTC `interval:<seconds>` jobs. It claims due rows with `FOR UPDATE SKIP LOCKED`, uses a stable tick identity, revalidates current workspace membership, full hierarchy, and provider-set policy, then creates the run, frozen provider set, outbox event, and next cursor transactionally. Invalid current state rolls back run creation, safely pauses the schedule, and creates one admin notification.

Report-ready, budget-paused, and administrative failure notifications are idempotent database records delivered internally through the outbox and `notification_queue`. No external email, chat, or webhook delivery is implemented.

## Health and readiness

- `GET /health` reports process liveness only.
- `GET /ready` checks PostgreSQL, the exact migration ledger, RabbitMQ, and every production queue/DLQ.

Readiness does not call external providers and does not require Redis or Elasticsearch.

## Local setup

Requirements: Node.js 22+, Docker with Compose, and npm.

```bash
copy .env.example .env
npm ci
npm run infra:up
npm run migrate
```

Run the complete default V6 process set in separate terminals:

```bash
npm run dev
npm run outbox:dev
npm run analysis-worker:dev
npm run analysis-item-worker:dev
npm run llm-run-worker:dev
npm run prompt-worker:dev
npm run mock-provider-worker:dev
npm run scoring-worker:dev
npm run scheduler-worker:dev
npm run notification-worker:dev
```

Enable and start real provider workers only with the corresponding API keys and `ENABLE_REAL_PROVIDERS=true`:

```bash
npm run openai-provider-worker:dev
npm run gemini-provider-worker:dev
npm run claude-provider-worker:dev
```

Compose can build and start the complete default V6 process set with `npm run docker:up`, or only the API and its dependencies with `npm run docker:api`. Redis and Elasticsearch are retained only under the explicit `v65-deferred` profile and are not V6 runtime dependencies.

## Verification

Start isolated test infrastructure with `npm run infra:test:up`, then use:

```bash
npm run test:unit
npm run test:migrations
npm run test:integration
npm run test:e2e
npm run test:all
npm run verify
```

The phase-named commands remain available as focused regression suites. `verify` runs source/test typechecks, 117 unit tests, 10 migration tests, 96 phase integration tests, 9 final E2E journeys, the production build, and `git diff --check`.

## HTTP surface

```text
GET  /health
GET  /ready
GET  /openapi.json
GET  /docs
POST /v1/analysis
GET  /v1/analysis/runs/:analysisRunId
GET  /v1/analysis/runs/:analysisRunId/report
POST /v1/analysis/runs/:analysisRunId/cancel
```

Use `X-Anonymous-Session-Token`, or `Authorization: Bearer …` plus `X-Workspace-Id`. A claimed request may include both credential forms. Swagger UI at `/docs` documents request compatibility, provider-set idempotency, report coverage/lifecycle states, and the cancellation boundary.

## Scope

Implemented V6 scope is the production core described above. Redis execution, Elasticsearch execution, market/country/global scopes, prompt experimentation, provider racing or fallback, additional providers, crawler, RAG, agents, frontend, billing/payments, and microservice extraction are deferred and are not claimed by this repository.
