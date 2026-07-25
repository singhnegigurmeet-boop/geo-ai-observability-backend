# GEO V6 Production Core Flow

PostgreSQL is authoritative. RabbitMQ messages carry only the primary
aggregate ID; every worker reloads and locks the current database state before
acting. Legacy queued messages with linkage metadata remain readable, and any
metadata they contain is checked against PostgreSQL.

## Submission and provider-set identity

```text
POST /v1/analysis
  -> authenticate anonymous session or user/workspace
  -> normalize domain and validate active hierarchy relationships
  -> resolve providerModels (anonymous: mock/mock-fast; user: configured set)
  -> normalize, deduplicate, and sort provider/model pairs
  -> transactionally create analysis_run
  -> freeze analysis_run_provider_models
  -> emit analysis_run.created { analysisRunId }
```

The normalized provider set is part of canonical idempotency identity.
Reordering or duplicating the same set replays the run; changing the normalized
set conflicts under the same owner-scoped idempotency key. Frozen provider rows
are immutable.

## Expansion and planning

```text
analysis_run.created { analysisRunId }
  -> expand one active relationship level
  -> analysis_run_item.created { analysisRunItemId }
  -> llm_run.created { llmRunId }
  -> prompt_job.created { promptJobId }
```

Anonymous work selects at most three children and uses three `v1_light`
prompts. User and valid claimed work selects at most five children and uses
five `v1` prompts. All hierarchy truth is loaded from active relationship rows,
never inferred from materialized `entity_paths`.

If expansion has no eligible target, the run becomes `completed`, an immutable
`completed_empty` report is created, and no failure record, retry, or DLQ entry
is produced.

## Prompt rendering and provider fan-out

```text
prompt_job.created { promptJobId }
  -> render canonical prompt once
  -> for each frozen provider/model pair:
       create provider_job
       emit provider_job.created { providerJobId }
```

Provider queues are selected from the authoritative provider job. A queue
worker also supplies its expected provider, so a job delivered to the wrong
provider queue is rejected.

## Evidence, scoring, and parent state

```text
provider_job.created { providerJobId }
  -> reserve budget
  -> execute provider
  -> persist immutable provider_result and actual usage
  -> emit provider_result.created { providerResultId }
  -> backend-v1 score
  -> create an immutable report revision
```

A prompt succeeds only when all sibling provider jobs succeed. Active,
budget-paused, failed, invalid, and cancelled siblings derive prompt, LLM-run,
item, and run state under deterministic run-to-provider lock ordering.
Successful siblings and their evidence are never rewritten when another
sibling pauses or fails.

Malformed successful provider responses create an immutable `invalid`
`provider_result` containing safely retained raw evidence and validation
errors. Invalid evidence is not scored and is not converted to zero. Transport,
timeout, rate-limit, and provider availability failures do not create invalid
evidence.

## Reports

`multi-provider-v2` reports are provider-execution aware:

```text
some scored evidence + unfinished work -> partial revision
additional scored evidence             -> new immutable revision
all provider executions terminal       -> final revision
budget reached                          -> budget_paused_partial
cancelled                               -> cancelled_partial/cancelled_empty
no valid evidence                       -> failed_empty
```

Each provider execution retains provider/model provenance, state, evidence
status, score, validation/failure metadata, and usage. Scores are averaged
equally across valid provider siblings for a prompt, then deterministically by
prompt type. Failed, invalid, cancelled, and missing evidence are coverage gaps,
not numeric zeroes. Report reads return the latest revision.

## Budget behavior

Budget checks and reservations are serialized with PostgreSQL locks. A hard
limit prevents the crossing execution; soft mode permits one crossing
execution. When a limit pauses a run, completed evidence remains intact,
unstarted siblings become `paused_budget`, a partial snapshot is created when
evidence exists, and the delivery is acknowledged without retry, failure
record, or DLQ. Automatic resume is not supported.

## Technical failure terminality

Attempts one and two record failure history and confirmed-republish the
message. A permanent error or exhausted final attempt transactionally records
the failure and terminalizes the addressed provider job, prompt job, LLM run,
run item, or analysis run. Parent state and the latest report snapshot are
derived before the message is rejected to its DLQ.

## Cancellation and claimed access

```text
POST /v1/analysis/runs/:analysisRunId/cancel
```

Cancellation succeeds only before any provider job has started. It
transactionally cancels all unstarted descendants, marks the run cancelled,
creates a cancelled report revision, and emits the database notification.
Repeated cancellation is idempotent; cancellation after provider execution
begins returns `409`.

When an anonymous session is claimed, the exact claimant user/workspace gains
derived access to pre-claim runs tied to that session. Other users and
workspaces do not.

## Scheduler

Due rows are claimed with `FOR UPDATE SKIP LOCKED`. Immediately before run
creation, the scheduler revalidates the creating user, workspace membership,
workspace state, starting path, and complete active hierarchy chain. Invalid
authorization or hierarchy pauses the schedule and records a safe operational
failure without leaving a run or analysis outbox event.

## Readiness and delivery

`GET /health` is process liveness. `GET /ready` checks PostgreSQL, the exact
checked-in migration ledger, RabbitMQ, and required queues. Notifications and
all business events use the transactional outbox; RabbitMQ is never treated as
business-state authority.
