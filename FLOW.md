# GEO V6 Runtime Flow and Business Logic

This document describes the behavior implemented by GEO V6 Production Core.
PostgreSQL is the authoritative source of business state. RabbitMQ transports
work asynchronously, and the transactional outbox is the database-to-broker
handoff. Queue ordering is not required for correctness.

A `prompt_job` is one rendered, versioned question. A `provider_job` is one
execution of that question by one frozen provider/model pair. Providers execute
independently; they are not fallbacks for one another. A `provider_result` is
stored evidence, while a `provider_score` and a `report` are interpretations of
that evidence.

## Core business rules

### Ownership and access

Requests enter with either:

- an anonymous session token; or
- a user session and workspace ID.

A claimed-session request may carry both. Claiming an anonymous session does
not rewrite historical run ownership. Access is derived from the exact
originating anonymous session and the active user/workspace membership.

Protected reads and cancellation use the shared ownership predicates. Creation
derives and persists ownership columns from the resolved ownership context; it
does not execute the same SQL predicate used by read and cancellation queries.

The authoritative identity tables are `anonymous_sessions`, `users`,
`user_sessions`, `workspaces`, and `workspace_members`. Session creation and
claiming are atomic.

### Hierarchy validation and expansion

Analysis accepts a normalized domain and an optional contiguous
category/brand/product/use-context path. Master tables and relationship tables
are hierarchy truth. `entity_paths` stores only a validated active chain.

Expansion applies these rules:

| Selected path | Expansion behavior |
| --- | --- |
| No path or a non-leaf path | Select eligible children exactly one level below the selected node |
| `use_context` leaf | Create one analysis item for the selected leaf itself |
| No eligible target | Create a `completed_empty` report outcome; this is not a technical failure |

Anonymous work deterministically selects at most three eligible targets. User
and claimed work select at most five.

### Provider-set policy

Provider/model pairs are validated against the supported configuration,
deduplicated, stably sorted, and frozen in
`analysis_run_provider_models`. Later configuration changes do not alter an
existing run.

| Actor | Default/allowed policy |
| --- | --- |
| Anonymous | Cannot explicitly submit provider models; resolves to `mock/mock-fast` |
| User or claimed | Defaults to `mock/mock-standard`; an explicit set must contain one to four supported pairs |

Real-provider pairs are also subject to their feature/configuration gates.

### Idempotency

For `POST /v1/analysis`, the database idempotency key is the client-provided key
namespaced by the resolved owner. The stored canonical request contains the
normalized domain, validated hierarchy IDs, and normalized provider/model set.
The request source is not part of that canonical request.

- The same owner key and the same canonical request return the existing run.
- The same owner key with a different canonical request conflicts.
- Different owners do not share an idempotency namespace.

Scheduled runs use the scheduler identity
`scheduled_analysis:<schedulerJobId>:<dueAt>`. Their stored request payload
captures the validated scheduled inputs, including the frozen provider set.

### Prompt-plan policy

Anonymous analyses use the reduced three-prompt plan. User and claimed analyses
use the five-prompt plan. Each prompt identity is the LLM run, prompt type, and
prompt version.

### Provider evidence

- A valid answer is stored as valid, immutable evidence and is eligible for
  scoring.
- A valid provider refusal remains valid, scorable evidence.
- A successful response with an invalid structure is stored as terminal invalid
  evidence and is not scored.
- Transport, timeout, authentication, and configuration errors are technical
  failures.
- Successful siblings remain independently usable when another provider fails.

### Budget admission and usage

Before calling a provider, the worker locks the provider job and applicable
active budget policies. Policies are ordered deterministically by scope and
identity. The most restrictive applicable scope controls admission.

| Condition | Result |
| --- | --- |
| Hard limit would be exceeded | Pause the provider job before the call |
| Soft limit is not yet crossed | Allow the current reservation, including the one crossing the limit |
| Soft limit is already crossed | Pause later work |

A budget pause is a business-terminal state. It creates no technical failure
record, retry, or DLQ message.

Estimated and actual `token_usage` rows are immutable records. Actual usage does
not physically replace the estimate. Budget accounting selects one effective
row per provider job, preferring actual usage when present and otherwise using
the estimate. This prevents retries from double-counting a job.

### Derived lifecycle

Lifecycle is derived from persisted child states rather than in-memory
counters. The shared derivation applies these principles:

- any active child keeps its parent active;
- a paused child can produce `paused_budget`;
- all successful children produce success;
- a mixture of successful and failed/cancelled children produces
  `partial_success`;
- all cancelled children produce cancellation;
- otherwise terminal unsuccessful children produce failure.

After provider execution completes, scoring and report aggregation finalize the
run outcome. A completed child is never intentionally moved backward.

### Report readiness and outcomes

Report aggregation counts frozen provider/model outcomes. Only valid scored
evidence contributes to the arithmetic mean; invalid, failed, cancelled, and
missing evidence is excluded rather than counted as zero. Scored siblings have
equal weight.

The aggregate lifecycle decision is:

| Condition | `report_data.lifecycleState` |
| --- | --- |
| Budget-paused outcomes and at least one score | `budget_paused_partial` |
| Budget-paused outcomes and no score | `failed_empty` |
| Cancelled run/outcomes and at least one score | `cancelled_partial` |
| Cancelled run/outcomes and no score | `cancelled_empty` |
| Required work is still nonterminal | `partial` |
| No score exists after terminal work | `failed_empty` |
| At least one score and at least one failed, invalid, or cancelled gap | `completed_with_gaps` |
| All required outcomes are scored | `completed` |
| Expansion produced no item | `completed_empty` |

`completed_empty` and `cancelled_empty` are produced by the empty-outcome
service rather than the normal score aggregator.

The report row status maps `partial`, `budget_paused_partial`, and
`cancelled_partial` to `partial`; maps `failed_empty` and `cancelled_empty` to
`failed`; and maps the remaining final aggregate outcomes to `completed`.

A meaningful report change creates a new immutable revision. A deep-equal
projection does not create a duplicate revision. Partial revisions may be
created as evidence arrives and are not final.

### Cancellation

`POST /v1/analysis/runs/:analysisRunId/cancel` is allowed only when the caller
owns the run and provider execution has not begun. A provider job with
`started_at`, `processing`, or `succeeded` makes cancellation conflict.

An accepted cancellation:

1. locks the run;
2. cancels unstarted provider jobs and eligible ancestors;
3. derives parent states;
4. creates the applicable cancelled report outcome; and
5. relies on database notification rules for an eligible owner.

Repeated cancellation of an already cancelled run is a no-op. Delayed messages
reload state and become no-ops. Baseline owner notifications for cancellation
are created only for user/workspace-owned runs, not anonymous runs.

### Scheduler

The scheduler is a polling worker, not a RabbitMQ consumer. It claims due
`scheduler_jobs` with `SKIP LOCKED` and, for each tick, revalidates:

- the active user;
- the non-deleted workspace and active membership;
- the hierarchy relationship chain;
- the configured provider/model set; and
- the UTC interval schedule.

A valid tick uses `SchedulerRepository.createOrReuseRun`, which directly
creates/reuses the scheduled analysis run, freezes provider rows, writes the
analysis-run outbox event, and advances the schedule cursor. This is a separate
creation path from `AnalysisService`, although it applies the corresponding
authorization, hierarchy, provider, and idempotency policies.

An invalid tick rolls back its savepoint, pauses the schedule, and records a
permanent scheduler failure. The database trigger creates the admin
notification. `scheduler_queue` is declared in broker topology and used as a
failure-record queue name, but no scheduler RabbitMQ consumer currently drains
it.

### Notifications

Notifications are internal database delivery records. The notification worker
locks and reloads each row; an already-sent row is a no-op. Unsupported external
delivery is treated as permanent because no external channel is implemented.

Baseline triggers create report, budget-pause, and cancellation notifications
only for user/workspace-owned analyses. Terminal technical failure and invalid
scheduler notifications are administrative and are created for permanent or
exhausted failures. The logical database transition is idempotent, while
RabbitMQ delivery remains at least once.

## Transaction and locking behavior

Each stage performs its local state change, child creation, and downstream
outbox write in a database transaction. Duplicate delivery normally observes a
committed state or unique identity and becomes a no-op.

`ExecutionStateService` locks a tree in run-to-leaf order, with rows ordered by
ID within a level:

```text
analysis_run
-> analysis_run_item
-> llm_run
-> prompt_job
-> provider_job
```

That service-level order is not a repository-wide global lock order. Some
callers already hold a leaf lock before lifecycle recalculation:

- provider execution locks `provider_job` first;
- scoring locks `provider_result` first; and
- cancellation locks the `analysis_run` before descendants.

The implementation therefore must not be described as enforcing one universal
root-to-leaf lock direction. Deterministic policy locking and row ordering
reduce contention, and concurrency tests exercise important paths, but a global
lock-order guarantee is not currently encoded.

## Runtime stages

### 1. Analysis creation

- Entry: validated `POST /v1/analysis`, or an authorized scheduler tick through
  its separate repository path
- Writes: `analysis_runs`, `analysis_run_provider_models`, `outbox_events`
- Event: `analysis_run.created { analysisRunId }`
- Queue: `analysis_run_queue`
- Initial state: `queued`

A transaction failure leaves neither the run nor its outbox event.

### 2. Outbox publication

The dispatcher claims eligible `outbox_events` with `SKIP LOCKED`, publishes
through a RabbitMQ confirm channel, and marks an event published only after
broker confirmation. Failed publication remains eligible for bounded backoff.
Multiple dispatchers can divide work safely.

### 3. Analysis expansion

- Worker: analysis-run worker
- Primary aggregate: `analysis_runs`
- Writes: `analysis_run_items` and one outbox event per item
- Event: `analysis_run_item.created { analysisRunItemId }`
- Queue: `analysis_run_item_queue`
- Identity: analysis run plus materialized target path

### 4. LLM-run creation

- Worker: analysis-item worker
- Primary aggregate: `analysis_run_items`
- Writes: one primary `llm_runs` row and its outbox event
- Event: `llm_run.created { llmRunId }`
- Queue: `llm_run_queue`
- Identity: analysis item plus primary-run key

The item enters processing in the same transaction.

### 5. Prompt planning

- Worker: LLM-run worker
- Primary aggregate: `llm_runs`
- Writes: logical `prompt_jobs` and their outbox events
- Event: `prompt_job.created { promptJobId }`
- Queues: prompt-type queues
- Identity: LLM run, prompt type, and prompt version

### 6. Rendering and provider fan-out

- Worker: prompt worker
- Primary aggregate: `prompt_jobs`
- Inputs: authoritative hierarchy plus frozen provider/model rows
- Writes: rendered prompt, one `provider_jobs` row and outbox event per pair
- Event: `provider_job.created { providerJobId }`
- Queue: provider-specific queue
- Identity: prompt job, provider, and model

Rendering must succeed before fan-out. Fan-out is transactional and
idempotent. A successful provider cannot complete a prompt while a sibling is
active.

### 7. Provider execution

- Worker: mock or provider-specific worker
- Primary aggregate: `provider_jobs`
- Input: stored rendered prompt and provider/model
- Writes: at most one `provider_results` row plus usage reconciliation
- Event: `provider_result.created { providerResultId }`
- Queue: `scoring_queue`
- Identity: provider job

### 8. Scoring and reporting

- Worker: scoring worker
- Primary aggregate: `provider_results`
- Writes: one `provider_scores` row per result/scoring version, derived
  lifecycles, and any changed report revision
- Identity: provider result plus scoring version

Only valid evidence is scored. Sibling results and scores remain independent.

## Technical retry and DLQ flow

Rabbit-backed processing uses the reliable worker runtime:

1. Record the failed attempt.
2. Before exhaustion, republish with broker confirmation and acknowledge the
   original only after confirmation.
3. On the third attempt, or immediately for a permanent error, record one
   logical terminal failure.
4. Terminalize the addressed business aggregate when that aggregate type is
   supported by the failure repository.
5. Reject the original message without requeue so it reaches the queue's DLQ.

Business terminalization is implemented for `provider_job`, `prompt_job`,
`llm_run`, `analysis_run_item`, and `analysis_run`. It derives parent state and
report state for those supported aggregates.

There is no equivalent business terminalizer for `provider_result` or
`notification`. In particular, exhausted scoring work records the
failure/DLQ/admin signal but can leave valid evidence unscored; report readiness
continues to regard that result as nonterminal. This is a current implementation
gap, not a completed-state guarantee.

The scheduler uses its polling/savepoint failure path described above rather
than the Rabbit reliable-worker retry loop.

## Queue and event contract

Payloads carry an ID only; workers reload authoritative state from PostgreSQL.

| Event | Payload field | Main queue |
| --- | --- | --- |
| `analysis_run.created` | `analysisRunId` | `analysis_run_queue` |
| `analysis_run_item.created` | `analysisRunItemId` | `analysis_run_item_queue` |
| `llm_run.created` | `llmRunId` | `llm_run_queue` |
| `prompt_job.created` | `promptJobId` | one of the five prompt queues |
| `provider_job.created` | `providerJobId` | provider-specific queue |
| `provider_result.created` | `providerResultId` | `scoring_queue` |
| `notification.created` | `notificationId` | `notification_queue` |

The declared topology contains 15 main queues: three analysis/LLM queues, five
prompt queues, four provider queues, `scoring_queue`, `scheduler_queue`, and
`notification_queue`. Every declared main queue has a DLQ. As noted above,
`scheduler_queue` currently has no consuming scheduler worker.

## Health and readiness

`GET /health` reports process liveness.

`GET /ready` checks:

- PostgreSQL connectivity;
- the exact checksum and sole migration-ledger row for
  `001_v6_final_baseline.sql`;
- RabbitMQ connectivity; and
- all required main queues and their DLQs.

Missing, extra, unknown, or checksum-mismatched migration state is not ready.
Readiness does not call external providers.

## Public reads and data exposure

Run status and latest-report reads use the ownership policy. Public DTOs expose
lifecycle state, the latest report revision, aggregate interpretation,
provider/model coverage, and `analysis_runs.error_message`.

Raw provider response bodies, credentials, session secrets, and RabbitMQ
metadata are not included in those DTOs. However, `error_message` is currently
returned from stored run state without a comprehensive sanitization layer.
Code that persists technical messages must therefore avoid secrets and raw
upstream payloads.

## Current implementation boundaries

The following are deliberately documented as current behavior, not guarantees:

1. There is no repository-wide global lock order across all worker paths.
2. Exhausted scoring work has no `provider_result` business terminalizer and
   can leave report readiness waiting on an unscored valid result.
3. The scheduler creates runs through its repository path and does not consume
   `scheduler_queue`.
4. Public run reads return the stored run `error_message`; arbitrary technical
   messages are not comprehensively sanitized at the response boundary.
