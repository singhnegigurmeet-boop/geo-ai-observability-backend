# Phase 2 Outbox Delivery Flow

## Process Boundaries

```text
HTTP process
  -> health and OpenAPI endpoints only

Outbox dispatcher process
  -> PostgreSQL outbox repository
  -> RabbitMQ confirm publisher
```

The HTTP process does not start the dispatcher. No business consumers or workers exist in Phase 2.

## Reliable Handoff

Future business transactions will write authoritative state and an `outbox_events` row in the same PostgreSQL transaction.

```text
PostgreSQL transaction commits
  -> outbox event becomes pending
  -> dispatcher claims event in a short transaction
  -> event becomes publishing with a lease and incremented attempt
  -> transaction commits
  -> dispatcher publishes a persistent message
  -> RabbitMQ confirms responsibility
  -> dispatcher conditionally marks the owned lease published
```

The database transaction is never held open while waiting for RabbitMQ.

## Claiming and Recovery

Eligible rows are:

- `pending` or `failed` with `available_at <= now()`
- `publishing` with an expired `locked_at` lease

Claims use `FOR UPDATE SKIP LOCKED`, allowing multiple dispatcher processes to divide work without selecting the same row. A failed publication clears its lease, records the error, and advances `available_at` with capped exponential backoff.

Rows already marked `published` are never selected again. A crash between broker confirmation and the database success update can still produce a duplicate after lease recovery, so delivery semantics are at least once.

## RabbitMQ Topology

```text
geo.v6.main (durable direct exchange)
  -> 13 frozen durable quorum queues

each main queue
  -> geo.v6.dlx on rejected/non-requeued delivery
  -> <main-queue>.dlq
```

Routing keys are the frozen queue names. Outbox `headers.queueName` must contain one of those names. Messages contain stable identifiers and metadata; future workers must reload state from PostgreSQL.

Publisher failure retries remain in PostgreSQL. Broker retry queues are deferred until consumer retry behavior is implemented and frozen.

## Dispatcher Shutdown

```text
SIGINT or SIGTERM
  -> abort polling
  -> finish the current claimed batch
  -> close RabbitMQ channel and connection
  -> close PostgreSQL pool
```

## Explicitly Not Implemented

- Business APIs or application services
- RabbitMQ business consumers
- Analysis or prompt workers
- Provider execution
- Score computation
- Report generation
- Notification delivery
- Scheduler execution
