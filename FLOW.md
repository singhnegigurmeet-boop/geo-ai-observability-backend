# Phase 10 Provider Budget Enforcement Flow

## Process Boundaries

```text
HTTP process
  -> public health and OpenAPI endpoints
  -> protected analysis submission and status endpoints

Outbox dispatcher process
  -> PostgreSQL outbox repository
  -> RabbitMQ confirm publisher

Analysis run worker process
  -> consume analysis_run_queue
  -> PostgreSQL locked expansion transaction
  -> analysis_run_item.created outbox events

Analysis run item worker process
  -> consume analysis_run_item_queue
  -> PostgreSQL locked item transaction
  -> llm_run.created outbox event

LLM run worker process
  -> consume llm_run_queue
  -> PostgreSQL locked planning transaction
  -> actor-specific prompt_job.created outbox events

Prompt worker process
  -> consume five prompt-type queues
  -> render from canonical PostgreSQL context
  -> provider_job.created outbox event

Mock provider worker process
  -> consume mock_queue
  -> PostgreSQL locked budget + evidence transaction
  -> estimated token_usage reservation before execution
  -> provider_results + actual token_usage
  -> provider_result.created outbox event

Provider score worker process
  -> consume scoring_queue
  -> PostgreSQL locked scoring transaction
  -> immutable provider_scores
  -> run-level report readiness check
  -> immutable basic report when all planned prompts are scored
```

## Submission

```text
POST /v1/analysis
  -> resolve anonymous or user/workspace ownership
  -> require Idempotency-Key
  -> validate a contiguous hierarchy request
  -> parse hostile input into a validated public ASCII hostname
  -> begin PostgreSQL transaction
  -> find/create normalized domain
  -> validate active DB-controlled hierarchy masters
  -> validate the explicit active relationship chain
  -> create/reuse exact starting entity_path
  -> derive owner-scoped idempotency key
  -> create/replay analysis_run
  -> create analysis_run.created outbox event for a new run
  -> commit
  -> return 202
```

The raw domain is discarded at the input boundary. Bare hostnames and HTTP(S) URL-like values are reduced to a lowercase hostname after removing protocol, port, path, query, hash, and a leading `www.`. Instruction-like input, HTML/script forms, IPs, localhost/internal names, IDNs, and malformed labels are rejected.

Only the normalized hostname is stored in `domains`, persisted in `analysis_runs.request_payload`, and returned by status reads. Outbox payloads contain IDs only.

The normalized request persisted in `analysis_runs.request_payload` has fixed fields:

```text
domain
categoryId
brandId
productId
useContextId
requestedProvider
requestedModel
```

Missing hierarchy IDs are stored as `null`. Anonymous model fields are null because policy fixes its cheap model. User/claimed fields contain the resolved mock provider and selected/default model. This canonical form makes casing and a trailing domain dot idempotently equivalent while keeping model choices distinct.

Migration `019` stores the authoritative user/claimed preference on `analysis_runs`. Anonymous runs cannot store a selection. The resolved provider/model also participates in canonical request comparison, so a model change cannot replay an incompatible run.

Future network-fetch code must still resolve and validate destination addresses at fetch time and after redirects; normalization does not replace an SSRF-safe network policy.

## Idempotency

```text
anonymous:<anonymousSessionId>:<clientKey>
user:<userId>:<workspaceId>:<clientKey>
```

```text
same owner + same key + same canonical request
  -> existing run, idempotentReplay=true

same owner + same key + different canonical request
  -> 409 CONFLICT

different owner + same client key
  -> independent run

same owner + same key + different resolved model
  -> 409 CONFLICT
```

Only a newly inserted run gets an outbox event. Concurrent inserts rely on the database uniqueness constraint and reload the winning row.

## Hierarchy

The only accepted shapes are:

```text
domain
domain + category
domain + category + brand
domain + category + brand + product
domain + category + brand + product + use_context
```

Categories, brands, products, and use contexts are DB-controlled master records. Explicit relationship tables define the valid cascade:

```text
domains
  -> domain_categories
  -> category_brands
  -> brand_products
  -> product_use_contexts
```

Normal analysis submission does not create master or relationship rows. It validates the controlled relationship chain, then creates/reuses only the exact selected `entity_path`.

`entity_paths` is a reusable materialized path registry for analysis state; it is not hierarchy relationship authority. Existing historical paths remain valid, but migration `016` deliberately does not promote them into controlled relationship rows.

Future expansion traverses active relationship rows using:

```text
sort_order ASC NULLS LAST
created_at ASC
relationship_id ASC
```

The submission API creates or reuses only the selected exact path. It does not produce expanded paths or `analysis_run_items`.

## Phase 5 Expansion

```text
consume analysis_run.created
  -> validate envelope and ID-only ownership payload
  -> begin PostgreSQL transaction
  -> SELECT analysis_run FOR UPDATE
  -> non-queued run: idempotent no-op
  -> verify payload against authoritative run
  -> load active starting path and explicit relationship chain
  -> select exactly one active child level
  -> create/reuse materialized child entity_paths
  -> create/reuse queued analysis_run_items
  -> create/reuse analysis_run_item.created outbox events
  -> mark run processing, or failed with NO_EXPANSION_CHILDREN
  -> commit
  -> acknowledge delivery
```

Expansion source and breadth:

```text
domain -> domain_categories -> category paths
category -> category_brands -> brand paths
brand -> brand_products -> product paths
product -> product_use_contexts -> use-context paths
use_context -> one direct item for the same full path

anonymous -> top 3
user or claimed user/workspace -> top 5
```

`entity_paths` only materializes selected paths. It is never queried to infer child relationships. Items use deterministic zero-based ordinals. Stable database keys prevent duplicate items and outbox events on redelivery.

Successful expansion sets `processing` and `started_at`. Empty expansion sets `failed`, `NO_EXPANSION_CHILDREN`, and `completed_at`; it is a committed business result and is not sent to a DLQ. Technical failures roll back, leaving a queued run unchanged.

## Worker Retry and DLQ

```text
worker attempt 1 or 2
  -> record failure_records row
  -> confirmed republish to analysis_run_queue
  -> increment x-worker-attempt header
  -> acknowledge original

worker attempt 3
  -> record final failure
  -> reject without requeue
  -> existing DLX routes to analysis_run_queue.dlq
```

The `x-worker-attempt` consumer header is independent of the queue envelope's outbox publication `attempt`. If failure recording or retry publication fails, the original delivery is requeued.

The same reliable consumer implementation handles Phases 5 through 8 with fixed queue names. Phase 6 retries exhaust into `analysis_run_item_queue.dlq`.

Phase 7 uses that same runtime with the fixed `llm_run_queue`. Technical failures are recorded for attempts one through three and exhaust into `llm_run_queue.dlq`. Malformed messages are permanent failures; authoritative-state mismatches remain retryable technical failures.

## Phase 6 Item-to-LLM-Run

```text
consume analysis_run_item.created
  -> validate strict ID-only envelope
  -> begin PostgreSQL transaction
  -> SELECT analysis_run_item FOR UPDATE
  -> non-queued item: idempotent no-op
  -> load parent analysis_run
  -> load active item entity_path
  -> validate run, path, starting path, and ownership IDs
  -> create/reuse llm_run with run_key=primary
  -> create/reuse llm_run.created outbox event
  -> mark analysis_run_item processing
  -> commit
  -> acknowledge delivery
```

Stable identities:

```text
llm_run idempotency_key: llm_run:<analysisRunItemId>
outbox event_key: llm_run.created:<llmRunId>
```

The `llm_runs` row is only a control/planning unit linked to its analysis item. It contains no prompt text and no provider/model selection. The outbox payload contains only LLM-run, item, parent-run, path, starting-path, and ownership IDs. A claimed run remains a user-owned event while preserving its anonymous-session origin.

Phase 6 does not update or complete the parent `analysis_run`. It creates no `prompt_jobs`, provider work/results, token usage, scores, reports, or budgets.

## Phase 7 LLM-Run-to-Prompt Planning

```text
consume llm_run.created
  -> validate strict ID-only envelope
  -> begin PostgreSQL transaction
  -> SELECT llm_run FOR UPDATE
  -> non-queued LLM run: idempotent no-op
  -> load parent analysis_run_item and analysis_run
  -> load active item entity_path
  -> validate item, run, path, starting path, and ownership IDs
  -> call actor-aware prompt policy
  -> create/reuse the selected pending, unrendered prompt_jobs
  -> create/reuse one prompt_job.created outbox event per job
  -> mark llm_run processing
  -> commit
  -> acknowledge delivery
```

The plans are differentiated:

```text
anonymous:
  visibility v1_light -> visibility_prompt_queue
  competitor v1_light -> competitor_prompt_queue
  ranking    v1_light -> ranking_prompt_queue

user or valid claim:
  visibility  v1 -> visibility_prompt_queue
  competitor  v1 -> competitor_prompt_queue
  ranking     v1 -> ranking_prompt_queue
  price_range v1 -> price_range_prompt_queue
  pros_cons   v1 -> pros_cons_prompt_queue
```

Stable identities:

```text
prompt job: prompt_job:<llmRunId>:<promptType>:v1
outbox:     prompt_job.created:<promptJobId>
```

`prompt_text` is deliberately `NULL` at this stage. Migration `017` makes that state legal while retaining a null-or-nonblank database constraint. Each outbox payload contains only IDs, ownership fields, prompt type/version, and routing metadata. It contains no prompt text, domain text, provider configuration, or model choice.

Phase 7 does not update the parent item or analysis run and creates no provider jobs/results, token usage, scores, reports, budgets, scheduler jobs, or notifications.

## Phase 8 Prompt Rendering

```text
consume prompt_job.created from its prompt-type queue
  -> validate strict envelope and queue/prompt-type match
  -> begin PostgreSQL transaction
  -> SELECT prompt_job FOR UPDATE
  -> non-pending prompt job: idempotent no-op
  -> reload LLM run, item, run, active path, canonical names, and ownership
  -> validate every message identifier against authoritative state
  -> render deterministic, nonblank actor/version-specific prompt text
  -> apply provider/model policy from authoritative run preference
  -> create/reuse queued provider_job
  -> create/reuse provider_job.created outbox event for mock_queue
  -> mark prompt_job processing
  -> commit
```

Templates exist for competitor, ranking, visibility, price range, and pros/cons. They use only normalized domains and controlled hierarchy names loaded from PostgreSQL. Raw request input is not retained or rendered.

Stable identities:

```text
provider job: provider_job:<promptJobId>:mock:<resolvedModel>
outbox:       provider_job.created:<providerJobId>
```

`mock_queue` extends the Phase 2 topology with a dedicated quorum queue and DLQ. Mock work is never routed to `openai_queue`, `gemini_queue`, or `claude_queue`.

Migration `018` adds a PostgreSQL trigger that rejects any provider job whose referenced prompt text is null or blank. The prompt rendering update and provider job/outbox inserts still commit or roll back as one transaction.

## Phase 8 Mock Provider Execution

```text
consume provider_job.created from mock_queue
  -> validate strict mock / allowed-model envelope
  -> begin PostgreSQL transaction
  -> lock provider_job and prompt_job
  -> non-queued provider job: idempotent no-op
  -> verify provider/model and nonblank rendered prompt
  -> estimate provider/model token usage and integer micro-cost
  -> lock enabled platform/workspace provider budget policies
  -> hard/soft decision from DB-accounted usage
  -> create/reuse immutable estimated token_usage reservation
  -> create/reuse immutable deterministic provider_result
  -> create/reuse deterministic actual token_usage
  -> create/reuse ID-only provider_result.created outbox event
  -> mark provider_job and prompt_job succeeded
  -> commit
```

Evidence uses `provider = mock`, the exact resolved model (`mock-fast`, `mock-standard`, or `mock-quality`), a structured evidence array, and no score or report fields. Actual mock usage uses a deterministic prompt-length estimate, fixed output tokens, and local model-specific integer micro-cost. The schema links usage to provider/model through `provider_jobs`; those values are not duplicated in `token_usage`.

Technical failures roll the whole stage back and use the shared three-attempt retry/failure-record/DLQ behavior. Malformed messages are permanent failures. A budget rejection instead commits `paused_budget` state and returns normally, so the delivery is acknowledged without a failure record or DLQ.

## Phase 11 Real Provider Execution

```text
openai_queue | gemini_queue | claude_queue
  -> validate exact provider/model message and queue match
  -> lock authoritative provider/prompt/run state
  -> reserve against all applicable Phase 10 policies
  -> resolve one enabled provider adapter
  -> call its minimal text-generation REST endpoint with a bounded timeout
  -> preserve raw JSON and normalize answer/refusal as evidence
  -> use returned token usage or deterministic per-component fallback
  -> store immutable actual usage with local integer-micro pricing
  -> emit the existing provider_result.created scoring event
```

The allowlist is `openai/gpt-4o-mini`, `gemini/gemini-1.5-flash`, and `claude/claude-3-5-sonnet`. Real providers are disabled by default and never become the anonymous or user default. Valid refusals are evidence; adapters never compute scores or reports. Timeout, 429, network, and 5xx errors retry. Missing keys, invalid models, other 4xx responses, and malformed successful responses are permanent technical failures. All automated tests use injected clients and perform no real network calls.

## Phase 10 Budget Enforcement

The budget policy scopes are:

```text
platform_default -> every run for the selected provider
workspace        -> logged-in and claimed runs in that workspace
user             -> logged-in and claimed runs for that user
anonymous_session -> pure anonymous runs for that session
analysis_run     -> one exact anonymous, user, or claimed run
```

Anonymous runs receive platform, anonymous-session, and analysis-run policies without fake owners. Logged-in runs receive platform, workspace, user, and analysis-run policies. Claimed runs use that same logged-in scope set while preserving their anonymous origin; they do not apply anonymous-session limits.

Migrations `020` and `021` extend the existing scope enum and generic `budget_policies` table with user, anonymous-session, and analysis-run foreign keys plus optional model targeting. No scope-specific budget tables are introduced.

For every enabled applicable policy, the worker locks the policy row and accounts usage inside the same PostgreSQL transaction. Per provider job, accounting selects actual usage when available and estimated usage otherwise. This provides reservation and reconciliation without mutable accounting rows or an in-memory lock.

```text
hard:
  projected tokens/cost > limit -> pause before provider execution

soft:
  current tokens/cost <= limit -> allow the crossing prompt
  current tokens/cost > limit  -> pause later prompts
```

Policies are provider-specific and may optionally target one exact model. Provider-wide and exact-model policies both apply when relevant. Model-specific local estimation and pricing distinguish `mock-fast`, `mock-standard`, and `mock-quality`; all token and money units are integers. No pricing API or external tokenizer is used.

On budget pause, the transaction creates no provider result and no actual usage. It moves the current locked provider/prompt work and the related LLM runs, run items, and analysis run to `paused_budget`, using the stable user-facing message:

```text
Analysis paused because provider budget was reached before all prompts could be executed.
```

Later provider deliveries observe the paused parent run and pause their own already-locked job without acquiring the budget-policy lock. This avoids cross-job lock-order cycles. Redelivery of completed or paused provider jobs is an idempotent no-op. Concurrent jobs sharing a policy serialize on its row lock, so a hard limit cannot be overspent.

## Phase 9 Backend Scoring and Reporting

```text
consume provider_result.created from scoring_queue
  -> validate strict ID-only envelope
  -> begin PostgreSQL transaction
  -> lock provider_result, provider_job, and prompt_job
  -> validate message IDs against authoritative state
  -> require valid evidence and succeeded jobs
  -> calculate deterministic backend-v1 prompt-type score
  -> create/reuse immutable provider_score
  -> lock analysis_run to serialize concurrent final-score events
  -> count existing prompt_jobs and their valid versioned scores
  -> if incomplete: commit score without a report
  -> if complete: create/reuse immutable basic-v1 report
  -> complete llm_runs, analysis_run_items, and analysis_run
  -> commit
```

RabbitMQ carries provider-result, provider-job, prompt-job, and run IDs only. Evidence is reloaded from PostgreSQL. A provider-supplied `score` field is ignored; the backend formula uses a prompt-type baseline and bounded evidence confidence.

Report readiness derives from the prompt jobs already planned for the run:

```text
anonymous plan -> three scored prompts
user plan      -> five scored prompts
claimed plan   -> five scored prompts
```

No actor-specific counts are duplicated in report code. Run-row locking and existing score/report uniqueness constraints make concurrent completion and redelivery safe. The basic report contains overall score, prompt-type breakdown, evidence counts, provider/model provenance, and actual usage totals. It is deterministic backend output, not AI-written content.

`GET /v1/analysis/runs/:analysisRunId/report` applies the existing ownership rules and returns only the owned completed `basic-v1` report. An incomplete or differently owned report is not disclosed.

## Ownership Storage

```text
anonymous
  -> anonymous_session_id only

logged in
  -> user_id + workspace_id

validated claim
  -> preserved anonymous_session_id + user_id + workspace_id
```

Anonymous status/report access requires the same anonymous session and an anonymous-only run. User status/report access requires the same user and workspace. Missing or mismatched runs and reports return `NOT_FOUND`.

## Transactional Outbox

```text
one PostgreSQL transaction
  -> INSERT analysis_runs
  -> INSERT outbox_events
  -> COMMIT both or roll back both
```

Event:

```text
event_type: analysis_run.created
aggregate_type: analysis_run
headers.queueName: analysis_run_queue
```

Payload:

```text
analysisRunId
startingEntityPathId
actorType
userId
workspaceId
anonymousSessionId
```

No submitted domain text, prompt content, provider configuration, expanded item, score, or report is included.

## Status Read

`GET /v1/analysis/runs/:analysisRunId` returns authoritative run status and the starting path. It does not calculate progress or query run items, providers, scores, or reports.

## Phase 12 Operational Core

```text
scheduler_jobs due row
  -> transaction + FOR UPDATE SKIP LOCKED
  -> stable tick key scheduled_analysis:<jobId>:<dueAt>
  -> analysis_runs(source=scheduled) + analysis_run.created outbox
  -> advance next_run_at
  -> commit
```

The scheduler accepts UTC `interval:<seconds>` expressions from 60 through 31,536,000 seconds. Concurrent pollers cannot claim the same due row. Restart, retry, or transaction replay reuses the stable scheduled run. Invalid configuration rolls back partial tick work, pauses the job, and records a permanent failure.

```text
reports INSERT                 -> report_ready owner notification
analysis_runs -> paused_budget -> budget_paused owner notification
terminal/permanent failure     -> technical_failure admin notification

notification row + notification.created outbox
  -> notification_queue
  -> reload authoritative notification by ID
  -> mark internal delivery sent
```

Stable notification/outbox keys prevent duplication across source transitions and redelivery. Anonymous runs do not receive fake user/workspace recipients. No external delivery provider is used.

`GET /health` is lightweight liveness. `GET /ready` checks PostgreSQL, the exact migration ledger, RabbitMQ, and every main queue/DLQ. Readiness returns stable component states only. There is no public operations-summary endpoint because no admin authorization boundary exists.

## Explicitly Deferred to V6.5 or Later

- Provider fallback, racing, and advanced provider comparison
- Advanced billing, payment integration, and external pricing/tokenizer APIs
- Advanced scoring science, premium reports, and report diffs
- Redis cache, rate limiting, locks, and deduplication
- Country, market, and global scope
- External notification delivery and secure admin operations UI/API
- Crawler, RAG, agents, and frontend work

PostgreSQL remains the correctness and source-of-truth layer. RabbitMQ is transport, and the outbox remains the reliable database-to-broker handoff. Redis features remain deferred optimization/hardening work.

## Roadmap

Next: V6.5 hardening and product polish.

Later: final cleanup/consolidation, frontend, demo/video/message work, then the V7+ intelligence roadmap. The migration baseline, phase integration matrix, seed strategy, and final product documentation remain unchanged until the post-V6.5 stabilization pass.
