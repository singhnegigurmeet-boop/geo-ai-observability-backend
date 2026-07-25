# Phase 8 Prompt Rendering and Mock Evidence Flow

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
  -> PostgreSQL locked evidence transaction
  -> provider_results + actual token_usage
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
  -> create/reuse immutable deterministic provider_result
  -> create/reuse deterministic actual token_usage
  -> mark provider_job and prompt_job succeeded
  -> commit
```

Evidence uses `provider = mock`, the exact resolved model (`mock-fast`, `mock-standard`, or `mock-quality`), a structured evidence array, and no score or report fields. Actual mock usage uses a deterministic prompt-length estimate, fixed output tokens, and zero cost. The schema links usage to provider/model through `provider_jobs`; those values are not duplicated in `token_usage`.

Technical failures roll the whole stage back and use the shared three-attempt retry/failure-record/DLQ behavior. Malformed messages are permanent failures. No external provider network calls occur.

## Ownership Storage

```text
anonymous
  -> anonymous_session_id only

logged in
  -> user_id + workspace_id

validated claim
  -> preserved anonymous_session_id + user_id + workspace_id
```

Anonymous status access requires the same anonymous session and an anonymous-only run. User status access requires the same user and workspace. Missing or mismatched runs return `NOT_FOUND`.

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

## Explicitly Deferred

- Dynamic prompt/model policy and prompt experimentation
- Real provider execution and provider fallback
- Budget enforcement
- Scoring and reports
- Scheduler and notifications
- Redis cache, rate limiting, locks, and deduplication
- Country, market, and global scope

PostgreSQL remains the correctness and source-of-truth layer. RabbitMQ is transport, and the outbox remains the reliable database-to-broker handoff. Redis features remain deferred optimization/hardening work.
