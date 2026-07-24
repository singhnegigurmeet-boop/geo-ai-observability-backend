# GEO V6 Production Core Backend

This branch contains the Phase 3 identity, session, and workspace ownership core for GEO V6. The HTTP runtime remains a health/docs shell: identity components are internal building blocks and are not exposed as APIs or mounted globally.

## Implemented

- Production-safe PostgreSQL migrations and the frozen 26-table schema
- PostgreSQL outbox-to-RabbitMQ delivery infrastructure
- Opaque 256-bit user and anonymous session tokens
- HMAC-SHA-256 token hashing; only hashes are stored
- Transactional user, default-workspace, and owner-membership provisioning
- Anonymous-session creation, lookup, row-locked claim, and idempotent re-claim
- User-session lookup with expiry, revocation, and disabled-user checks
- Workspace membership lookup and explicit role authorization
- Framework-independent request ownership resolution
- Thin opt-in Express ownership middleware
- Stable identity error categories

Anonymous sessions never receive synthetic user or workspace identifiers. An anonymous token continues to resolve as anonymous after a claim. User privileges require a valid user token, an explicit `X-Workspace-Id`, current membership, and—when an anonymous token is also supplied—a matching recorded claim.

Raw session tokens are returned only when a session is created. They must not be logged or persisted by the server.

## Active HTTP Surface

```text
GET /health
GET /openapi.json
GET /docs
```

Health and documentation remain unauthenticated. Ownership middleware is deliberately not mounted on the application; a future protected route must opt in explicitly.

## Local Setup

Copy `.env.example` to `.env`, set a private `SESSION_TOKEN_PEPPER` of at least 32 characters, install dependencies, start infrastructure, and migrate:

```bash
npm install
npm run infra:up
npm run migrate
```

Start the HTTP shell and outbox dispatcher in separate terminals:

```bash
npm run dev
npm run outbox:dev
```

## Identity Credentials

The ownership middleware recognizes these credentials when attached to a protected route:

```text
Authorization: Bearer <user-session-token>
X-Workspace-Id: <workspace-id>
X-Anonymous-Session-Token: <anonymous-session-token>
```

- Anonymous token only: anonymous context
- User token plus workspace: logged-in workspace context
- User token, workspace, and anonymous token: user context only when the anonymous claim matches
- Workspace without user token: validation error
- No credentials: rejected by protected middleware only

## Verification

Run regular checks:

```bash
npm run typecheck
npm test
npm run build
```

Run database and messaging integration tests:

```bash
npm run infra:test:up
npm run test:migrations
npm run test:phase2
npm run test:phase3
npm run infra:test:down
```

The integration launchers wait for their dependencies. Test schema resets are guarded by a `_test` database-name suffix.

## Phase Boundary

Phase 3 does not add:

- Analysis or identity HTTP APIs
- Globally mounted authentication or ownership middleware
- RabbitMQ business consumers
- Analysis, prompt, provider, scheduler, or notification workers
- Provider integrations
- Scoring or report generation
