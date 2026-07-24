# Phase 3 Identity and Ownership Flow

## Process Boundaries

```text
HTTP process
  -> health and OpenAPI endpoints only
  -> ownership middleware available but not globally mounted

Outbox dispatcher process
  -> PostgreSQL outbox repository
  -> RabbitMQ confirm publisher
```

No identity API, business consumer, or business worker exists in Phase 3.

## Session Storage

```text
create session
  -> generate 32 cryptographically random bytes
  -> encode as an opaque base64url token
  -> HMAC-SHA-256 with the configured server pepper
  -> store only the token hash
  -> return the raw token once

resolve session
  -> hash the presented token
  -> load the authoritative PostgreSQL row
  -> reject missing, expired, revoked, or disabled identity
```

Raw tokens are credentials and must never be logged.

## User Provisioning

```text
one PostgreSQL transaction
  -> create user
  -> create default workspace
  -> create active owner membership
  -> commit all or roll back all
```

Workspace roles exist only on `workspace_members`.

## Anonymous Claim

```text
transaction begins
  -> SELECT anonymous session FOR UPDATE
  -> verify session is usable
  -> reject a different existing claimant
  -> verify the real user has current workspace membership
  -> return unchanged for the same claimant (idempotent)
  -> otherwise record claimed_by_user_id and claimed_workspace_id
  -> commit
```

The original `anonymous_session_id` is preserved. A claim does not upgrade the anonymous token into a user credential.

## Ownership Resolution

```text
anonymous token
  -> anonymous context only

user token + X-Workspace-Id
  -> validate user session
  -> validate current workspace membership
  -> user workspace context

user token + X-Workspace-Id + anonymous token
  -> validate both sessions
  -> require anonymous claim to match that user and workspace
  -> user workspace context with anonymous origin
```

`X-Workspace-Id` without a user token is invalid. Missing credentials are rejected only when a protected route mounts the ownership middleware; health and docs remain public.

## Stable Error Categories

```text
UNAUTHENTICATED
FORBIDDEN
NOT_FOUND
CONFLICT
VALIDATION_ERROR
EXPIRED_SESSION
REVOKED_SESSION
DISABLED_USER
```

## Existing Messaging Reliability

PostgreSQL remains authoritative. The standalone outbox dispatcher publishes persistent, ID-oriented messages with broker confirms and PostgreSQL-owned retry state. RabbitMQ is transport only, and Phase 3 adds no consumers.

## Explicitly Not Implemented

- Analysis or identity APIs
- RabbitMQ business consumers
- Analysis or prompt workers
- Provider execution
- Score computation
- Report generation
- Notification delivery
- Scheduler execution
