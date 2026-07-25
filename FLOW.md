# GEO V6 Runtime Flow

PostgreSQL is authoritative business truth. RabbitMQ is asynchronous transport.
The transactional outbox is the only database-to-broker handoff. Queue order is
never required for correctness.

A `prompt_job` is one logical, rendered, versioned question. A `provider_job` is
one execution of that question by one frozen provider/model pair. Providers run
independently; parallel execution is not racing and there is no fallback.
`provider_result` is immutable evidence. `provider_score` and `report` are
backend interpretations. A partial report is not final. A budget pause is not a
technical failure. A DLQ is operational transport history, not business state.

## Transaction and lock discipline

Workers begin by loading and locking the aggregate named by the event. Local
state, immutable child rows, parent lifecycle derivation, and downstream outbox
events are committed together. Duplicate delivery observes the committed state
and becomes a no-op.

The consistent lock direction is:

```text
analysis_run
-> analysis_run_item
-> llm_run
-> prompt_job
-> provider_job
-> provider_result / provider_score / report
```

Budget policy rows are locked in deterministic scope/identity order before a
provider reservation. Lifecycle derivation uses PostgreSQL child states, never
in-memory counters.

## Identity and ownership

Entry is an anonymous session token, or a user session plus workspace ID. A
request may carry both only for claimed-session access. Authoritative tables are
`anonymous_sessions`, `users`, `user_sessions`, `workspaces`, and
`workspace_members`.

Session creation and claims are atomic. Claim access is derived from the exact
originating anonymous session; it does not rewrite run ownership. Protected
reads, cancellation, and creation all use the same ownership clauses.

## Hierarchy validation and canonical request identity

Analysis entry accepts a domain and an optional contiguous
category/brand/product/use-context path. Master and relationship tables are
hierarchy truth. `entity_paths` materializes only a validated active chain.

The provider-set policy applies actor defaults, validates supported pairs and
the one-to-four user bound, deduplicates, stably sorts, and serializes the set.
Anonymous work resolves only to `mock/mock-fast`; user and claimed work default
to `mock/mock-standard`.

The normalized domain, validated path, ownership scope, source, and normalized
provider set form canonical idempotency identity.

## Analysis creation

- Entry: validated `POST /v1/analysis` or an authorized scheduler tick
- Tables: `analysis_runs`, `analysis_run_provider_models`, `outbox_events`
- Transaction: create/reuse the run, freeze provider rows, write its event
- Event/queue: `analysis_run.created { analysisRunId }` /
  `analysis_run_queue`
- Identity: owner-scoped canonical request key
- Initial state: `queued`

A duplicate canonical request returns the existing run. A transaction failure
leaves neither a run nor an outbox event.

## Outbox publication

The dispatcher claims eligible `outbox_events` with `SKIP LOCKED`, publishes to
the configured exchange using a confirm channel, and marks an event published
only after confirmation. Failed publication remains retryable with bounded
backoff. Multiple dispatchers safely divide work.

## Analysis expansion

- Worker: analysis-run worker
- Locked aggregate: `analysis_runs`
- Truth: active hierarchy relationships
- Output: `analysis_run_items` and one outbox event per item
- Event/queue: `analysis_run_item.created { analysisRunItemId }` /
  `analysis_run_item_queue`
- Identity: analysis run plus materialized child path

Anonymous work selects the deterministic top three; user and claimed work the
top five. Explicit deep paths expand exactly one level. No eligible target
produces completed-empty state rather than a technical failure.

## LLM-run creation

- Worker: analysis-item worker
- Locked aggregate: `analysis_run_items`
- Output: one primary `llm_runs` row
- Event/queue: `llm_run.created { llmRunId }` / `llm_run_queue`
- Identity: analysis item plus primary run key

The item enters processing in the same transaction as the LLM row and outbox
event.

## Prompt planning

- Worker: LLM-run worker
- Locked aggregate: `llm_runs`
- Output: logical `prompt_jobs`
- Event/queue: `prompt_job.created { promptJobId }` / prompt-type queue
- Identity: LLM run, prompt type, and prompt version

Anonymous policy creates the reduced three-prompt plan. User and claimed policy
creates the five-prompt plan.

## Prompt rendering and provider fan-out

- Worker: prompt worker
- Locked aggregate: `prompt_jobs`
- Truth: hierarchy state plus frozen `analysis_run_provider_models`
- Output: rendered prompt text, one `provider_jobs` row and outbox event per
  frozen pair
- Event: `provider_job.created { providerJobId }`
- Queue: provider-specific queue
- Identity: prompt job, provider, and model

Rendering must succeed before fan-out. Fan-out is transactional and
idempotent. One provider success cannot complete a prompt while a sibling is
active.

## Budget admission

The provider worker locks the queued `provider_job`, resolves all applicable
active `budget_policies`, then locks those policies in deterministic order.
Estimated `token_usage` is reserved before any provider call.

Hard limits pause before a call. Soft limits allow exactly one crossing
reservation and pause later work. The most restrictive applicable scope wins.
Budget-paused jobs are business-terminal, create no failure record, use no
retry, and do not enter a DLQ.

## Provider execution and evidence

- Workers: mock or provider-specific worker
- Locked aggregate: `provider_jobs`
- Adapter input: authoritative rendered prompt and stored provider/model
- Output: at most one immutable `provider_results` row and reconciled
  `token_usage`
- Event/queue: `provider_result.created { providerResultId }` /
  `scoring_queue`
- Identity: provider job

A valid refusal remains valid evidence. A structurally invalid successful
response is stored as terminal invalid evidence and is not scored. Transport,
timeout, authentication, and configuration failures are technical failures.
Actual usage replaces the reservation exactly once; retries cannot double
count.

## Scoring

- Worker: scoring worker
- Locked aggregate: `provider_results`
- Output: one immutable `provider_scores` row per result/scoring version
- Identity: provider result plus scoring version

Only valid evidence is scored. Invalid, failed, and missing evidence is excluded
from arithmetic rather than treated as zero. Sibling scores are accepted
independently.

## Lifecycle and report revisions

After each terminal local transition, the shared lifecycle implementation
derives `prompt_jobs`, `llm_runs`, `analysis_run_items`, and `analysis_runs`
from authoritative child states. Active children keep parents processing;
completed children never move backward.

Report readiness and aggregation use the same state projection. A meaningful
change creates a new immutable `reports` revision; deep-equal state does not.
Coverage includes every frozen provider/model outcome and retains provenance.
Valid scored siblings contribute an equal arithmetic mean.

Partial revisions are created as evidence arrives. Budget pause after evidence
creates a budget-paused partial. Final readiness waits until required work is
terminal and produces completed, completed-empty, failed-empty, or an honest
gap-aware final snapshot as applicable.

## Technical failure and retry

The reliable worker runtime handles every queue consistently:

1. A retryable failure records the attempt.
2. Attempts before exhaustion are republished with broker confirmation.
3. Exhaustion or a permanent failure records one logical terminal failure.
4. The addressed business aggregate is terminalized.
5. Parent lifecycle and any report snapshot are recalculated.
6. An applicable internal notification is created transactionally.
7. The original message is rejected to its DLQ.

Successful immutable siblings remain intact. Replayed terminal deliveries do
not duplicate failures, reports, or notifications.

## Cancellation

`POST /v1/analysis/runs/:analysisRunId/cancel` locks the owned analysis.
Cancellation is accepted only before any provider execution begins. It marks
unstarted descendants cancelled, derives parents, creates the applicable
cancelled report and notification, and commits atomically. Repeated cancellation
is a no-op. Once provider processing or success exists, cancellation conflicts.
Delayed queue events reload state and become no-ops.

## Scheduler

The scheduler claims due `scheduler_jobs` with `SKIP LOCKED`. For every tick it
revalidates active user, workspace, membership, path relationship chain, and
provider-set configuration. A valid tick calls the same analysis creation path
and advances its cursor once. Invalid state pauses the schedule and creates one
admin notification. Supported schedules are UTC intervals.

## Notifications

Report, budget-pause, cancellation, scheduler-invalid, and terminal technical
events create idempotent `notifications` plus
`notification.created { notificationId }`. The notification worker reloads the
row and records internal delivery exactly once. No external delivery channel is
implemented.

## Health and readiness

`GET /health` is process liveness.

`GET /ready` checks:

- PostgreSQL connectivity
- the exact checksum and sole ledger row for `001_v6_final_baseline.sql`
- RabbitMQ connectivity
- every required main queue and DLQ

An unmigrated, missing, extra, unknown, or checksum-mismatched migration state
is not ready. Readiness does not call providers.

## Public reads

Run status and latest-report reads use the shared ownership policy. Public DTOs
expose lifecycle, report revision, aggregate interpretation, provider/model
coverage, and sanitized failure categories. Raw provider responses, raw
upstream errors, credentials, session secrets, and RabbitMQ metadata remain
internal.
