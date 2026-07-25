# GEO V6 Runtime Flow

PostgreSQL is authoritative, RabbitMQ is transport, and the transactional outbox is the only database-to-broker handoff. Queue messages carry aggregate IDs. Workers reload and lock database state before acting; optional linkage in legacy queued envelopes is accepted only for compatibility and is validated against PostgreSQL.

## Stage map

| Stage | Authoritative tables and transaction | Event / queue / worker | Idempotency and state behavior |
|---|---|---|---|
| Request ownership | `user_sessions`, `anonymous_sessions`, `workspace_members`; middleware validates one ownership context before business work | HTTP API | Anonymous, user/workspace, and valid claimed-origin modes. Derived claimant access does not rewrite historical ownership. |
| Hierarchy and identity | Relationship tables are hierarchy truth; `entity_paths` are create/reuse materializations | HTTP API | Domain normalization plus active, contiguous master/edge validation. Provider set is validated, deduplicated, sorted, canonically serialized, and included in owner-scoped request identity. |
| Analysis creation | One transaction creates/replays `analysis_runs`, freezes `analysis_run_provider_models`, and inserts `outbox_events` | `analysis_run.created` → `analysis_run_queue` → analysis worker | Same normalized request replays one run; different request under the same key conflicts. Run starts `queued`. |
| Expansion | Worker locks the run and starting path, selects one active child level, creates `analysis_run_items` and outbox rows | `analysis_run_item.created` → `analysis_run_item_queue` → item worker | Deterministic breadth: anonymous 3, user/claimed 5. No eligible child creates `completed_empty`; no retry/failure/DLQ. |
| LLM run creation | Item worker transaction creates/reuses `llm_runs` and outbox rows | `llm_run.created` → `llm_run_queue` → LLM worker | Current V6 uses one stable run key per item while schema supports more. Cancelled/terminal parents no-op. |
| Prompt planning | LLM worker creates logical `prompt_jobs` and one event per prompt | `prompt_job.created` → one of five prompt queues → prompt worker | Anonymous uses three `v1_light` prompts; user/claimed uses five `v1` prompts. Prompt rows are logical prompts, not provider executions. |
| Rendering and fan-out | Prompt worker locks and renders one prompt, loads the frozen run set, then creates all `provider_jobs` and their outbox rows atomically | `provider_job.created` → provider-specific queue → provider worker | Unique `(prompt_job, provider, model)` plus stable event keys make fan-out idempotent. One provider job is created per frozen pair. |
| Budget admission | Provider execution transaction locks applicable `budget_policies`, records estimated `token_usage`, or pauses executable work | Same provider delivery | Hard mode blocks crossing; soft mode permits one crossing execution. Pause is a business outcome: acknowledge, preserve evidence, create a budget report/notification, and do not retry, fail, or DLQ. |
| Provider execution | Worker locks one `provider_job`; adapter result creates one immutable `provider_result`, reconciles actual usage, derives parent lifecycle, and writes outbox | `provider_result.created` → `scoring_queue` → scoring worker | Providers execute independently. There is no racing or fallback. Valid refusals are valid evidence. |
| Invalid evidence | A successful but malformed adapter response creates an immutable result with `invalid` status and safe validation metadata | `provider_result.created` → scoring worker | Terminal and unscored. It contributes coverage, never numeric zero, and does not use technical retry/DLQ. |
| Scoring | Scoring worker locks the result, creates one immutable `provider_score` for `backend-v1`, derives lifecycle, and builds a ready report revision | Report notification event may be written to outbox | Unique result/scoring version prevents duplicates. Scores are backend interpretation, never trusted from provider output. |
| Reporting | `reports` are immutable snapshots; readiness loads provider-aware execution coverage and selects the latest revision for reads | `notification.created` → `notification_queue` → notification worker | `multi-provider-v2`; valid sibling scores are equally averaged per logical prompt. Partial snapshots are not final and history is never mutated. |
| Technical failure | Reliable runtime records `failure_records`; terminalizer updates the addressed aggregate, invokes shared lifecycle/report derivation, and creates notifications in the transaction | Attempts 1–2 confirmed-republish; permanent/exhausted delivery rejects to its queue DLQ | Successful sibling evidence survives. Final failure cannot leave parents processing. DLQ is operational transport state, not business state. |

## Provider and lifecycle model

```text
analysis_run
  -> analysis_run_item
    -> llm_run
      -> prompt_job (one logical prompt)
        -> provider_job (one provider/model execution)
          -> provider_result (immutable evidence)
            -> provider_score (backend-v1 interpretation)
```

One prompt can have many provider jobs. Provider siblings may run concurrently, but the first completion does not win or cancel siblings. Parent rows remain active while executable work remains. The shared lifecycle boundary derives `provider_jobs -> prompt_job -> llm_run -> analysis_run_item -> analysis_run`; report readiness consumes that result.

Completed rows never move backward. Successful siblings remain successful when another sibling fails. Budget pause, invalid evidence, cancellation, empty expansion, and valid refusal are explicit business outcomes, not technical exceptions.

## Report lifecycle

Every report is an immutable `multi-provider-v2` revision:

| Lifecycle state | Meaning |
|---|---|
| `partial` | Scored evidence exists and provider work remains executable. |
| `budget_paused_partial` | Scored evidence exists and remaining work stopped at budget policy. |
| `completed` | All expected executions completed with scored evidence. |
| `completed_with_gaps` | Terminal with scored evidence plus failed, invalid, or cancelled coverage. |
| `failed_empty` | Terminal without valid scored evidence. |
| `cancelled_partial` / `cancelled_empty` | Cancellation won before provider execution, with/without evidence. |
| `completed_empty` | Expansion had no eligible targets. |

Coverage keeps provider/model, provider-job state, evidence state, score, and usage separate. Missing, invalid, failed, paused, and cancelled executions are not zero scores. Latest-report reads select the greatest immutable revision.

## Cancellation

`POST /v1/analysis/runs/:id/cancel` locks the owned run and descendants. Cancellation succeeds only before any provider execution begins, changes queued descendants to `cancelled`, and creates the appropriate empty/partial snapshot. Repeated cancellation is idempotent. Late cancellation conflicts. Delayed messages reload cancelled state and acknowledge as no-ops, without retries, failures, or DLQ messages.

## Claims and protected reads

Status, report, and cancellation use the same ownership SQL:

- Matching anonymous session owns its runs.
- Matching user and current workspace membership owns user runs.
- A claimed anonymous origin remains stored, and only its exact claimant gains derived access to runs created before the claim.

Cross-owner access is denied.

## Scheduled execution

The scheduler supports UTC `interval:<seconds>` only:

```text
claim due scheduler_jobs with FOR UPDATE SKIP LOCKED
  -> savepoint
  -> revalidate current workspace authorization
  -> validate the full active hierarchy path
  -> resolve the canonical provider set
  -> create run + frozen set + outbox + advance cursor
```

A stable scheduled tick is the idempotency identity. Invalid membership, hierarchy, or provider policy rolls back partial run creation, pauses the schedule safely, and records one administrative notification.

## Notifications, health, and readiness

Report-ready, budget-paused, and terminal administrative failure notifications are created transactionally and delivered internally through `notification_queue`. Delivery is idempotent; no external notification provider exists.

`GET /health` is process liveness. `GET /ready` checks PostgreSQL, the exact migrations `001`–`024`, RabbitMQ, and every declared production queue and DLQ. It does not call providers. Redis and Elasticsearch are deferred V6.5 infrastructure and are not part of V6 execution or readiness.

## Reliability distinctions

- Retryable technical failure: attempts one and two are recorded and confirmed-republished.
- Permanent/exhausted technical failure: terminalize, report/notify if ready, reject to DLQ.
- Invalid successful response: immutable invalid evidence, no normal score.
- Budget pause: business stop, no failure record or DLQ.
- Cancellation: business terminal state, delayed work no-ops.
- Valid refusal: valid provider evidence.
- Empty expansion: `completed_empty`.
- Successful completion: all provider-aware lifecycle work terminal and a final snapshot available.
