# Phase 4 Analysis Submission Flow

## Process Boundaries

```text
HTTP process
  -> public health and OpenAPI endpoints
  -> protected analysis submission and status endpoints

Outbox dispatcher process
  -> PostgreSQL outbox repository
  -> RabbitMQ confirm publisher

No business consumer or worker exists
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

The selected exact path is created or reused. No expanded paths or `analysis_run_items` are produced.

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

- RabbitMQ business consumers
- Analysis expansion worker
- Analysis run items
- LLM and prompt pipeline
- Provider execution
- Budget enforcement
- Scoring and reports
- Scheduler and notifications
