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
  -> normalize the domain
  -> begin PostgreSQL transaction
  -> find/create normalized domain
  -> validate active DB-controlled hierarchy IDs
  -> prove deeper parent relationships through active entity_paths
  -> create/reuse exact starting entity_path
  -> derive owner-scoped idempotency key
  -> create/replay analysis_run
  -> create analysis_run.created outbox event for a new run
  -> commit
  -> return 202
```

The normalized request persisted in `analysis_runs.request_payload` has fixed fields:

```text
domain
categoryId
brandId
productId
useContextId
```

Missing hierarchy IDs are stored as `null`. This canonical form makes casing and a trailing domain dot idempotently equivalent.

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

Categories, brands, products, and use contexts are DB-controlled master records. The API does not create them. Because those master tables do not contain parent foreign keys, deeper parentage is proven through existing active `entity_paths`.

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
