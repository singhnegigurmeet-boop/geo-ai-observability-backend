# Phase 1 Runtime and Migration Flow

## HTTP Runtime

```text
src/main.ts
  -> load validated environment
  -> create shared PostgreSQL, Redis, and Elasticsearch clients
  -> create Express app
  -> expose health and documentation routes
  -> listen on the configured port
```

The application does not run migrations automatically. It also does not start queues, workers, schedulers, provider calls, or analysis orchestration.

## Migration Flow

```text
npm run migrate
  -> discover ordered NNN_name.sql files
  -> acquire PostgreSQL advisory lock
  -> create geo_meta.schema_migrations when absent
  -> verify filenames and SHA-256 checksums of applied migrations
  -> reject a non-empty legacy public schema on first initialization
  -> apply each pending file in its own transaction
  -> record the applied version, filename, checksum, and timestamp
  -> release the advisory lock
```

The ordered migrations create enums first, then the frozen 26 production tables, followed by integrity triggers and indexes. A second run skips every recorded migration without changing data.

## Production Data Path Encoded by the Schema

```text
validated input
  -> analysis_runs
  -> entity_paths expansion
  -> analysis_run_items
  -> llm_runs
  -> prompt_jobs
  -> provider_jobs
  -> provider_results
  -> token_usage
  -> provider_scores
  -> reports
```

This is a database relationship contract only. Phase 1 does not implement the services that execute the flow.

`outbox_events` provides the future reliable database-to-queue handoff boundary. RabbitMQ and outbox delivery are not implemented in this phase.

## Ownership Contract

- Anonymous activity uses `anonymous_sessions`, without fake user or workspace IDs.
- Logged-in runs require both `user_id` and `workspace_id`, backed by workspace membership.
- Claimed runs retain their original `anonymous_session_id` while gaining user/workspace ownership.
- Workspace roles live in `workspace_members`; requested changes live in `workspace_role_change_requests`.

## Shutdown

```text
SIGINT or SIGTERM
  -> stop accepting HTTP requests
  -> close Redis client
  -> close PostgreSQL pool
  -> close Elasticsearch client
```

## Explicitly Not Implemented

- V6 business APIs and application services
- RabbitMQ or other queue runtime
- Workers and providers
- Analysis execution
- Score computation
- Report generation
- Notification delivery
- Scheduler execution
