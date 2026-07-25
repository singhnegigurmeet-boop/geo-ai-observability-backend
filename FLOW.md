# Phase 6 LLM Run Creation Flow

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
```

Missing hierarchy IDs are stored as `null`. This canonical form makes casing and a trailing domain dot idempotently equivalent.

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

The same reliable consumer implementation handles Phase 5 and Phase 6 with different fixed queue names. Phase 6 retries exhaust into `analysis_run_item_queue.dlq`.

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

- Prompt creation, rendering, and prompt/model policy
- Provider execution
- Budget enforcement
- Scoring and reports
- Scheduler and notifications
- Redis cache, rate limiting, locks, and deduplication
- Country, market, and global scope

PostgreSQL remains the correctness and source-of-truth layer. RabbitMQ is transport, and the outbox remains the reliable database-to-broker handoff. Redis features remain deferred optimization/hardening work.
