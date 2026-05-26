# Base Classes And Dependency Wiring

The backend uses small base classes only where they remove repeated plumbing.

## Documentation Rule

Markdown files are the project source of truth. When code changes the architecture, layer boundaries, dependency wiring, response shape, validation flow, or runtime behavior, update the relevant `.md` file in the same change.

## Composition Root

Runtime dependencies are wired in `src/container.ts`.

`main.ts` imports the ready-to-use services from the container:

```text
main.ts
  -> analysisCommandService
  -> analysisStatusService
  -> providerScoresService
  -> visibilityScoreReadService
  -> analysisJobService
  -> domainSchedulerService
  -> notificationService
  -> createApp(route services)
  -> createAnalysisWorker(analysisJobService)
  -> createSchedulerWorker(domainSchedulerService)
  -> createNotificationWorker(notificationService)
```

Service classes should not create repositories, queues, Redis clients, or Elasticsearch clients internally. They receive dependencies through constructors.

Infrastructure objects are created once and reused:

- PostgreSQL pool: `src/lib/postgres.ts`
- Redis connection: `src/lib/redis.ts`
- BullMQ queues: `src/queue/analysis.queue.ts`, `src/queue/scheduler.queue.ts`, `src/queue/notification.queue.ts`
- Elasticsearch client: `src/lib/elasticsearch.ts`
- Shared repositories: singleton exports in `src/repositories`
- Domain repositories/services/controllers/routes: colocated in `src/modules/*`
- Services: wired once in `src/container.ts`

Do not create database pools, Redis clients, BullMQ queues, repositories, or core services inside request handlers or job handlers.

## Modular Monolith

This is intentionally one application and one codebase. Domain-specific HTTP, service, and repository code is grouped by module:

```text
src/modules/
  analysis/
    controllers/
    routes/
    services/
    repositories/
  providers/
    controllers/
    routes/
    services/
    repositories/
    adapters/
  visibility/
    controllers/
    routes/
    services/
    repositories/
  diffs/
    services/
    repositories/
  scheduler/
    services/
    repositories/
  notifications/
    services/
    repositories/
  observability/
    services/
```

Shared infrastructure and small base classes remain outside modules:

```text
src/config
src/db
src/lib
src/middleware
src/queue
src/runtime
src/types
src/utils
```

Do not split these modules into microservices without a concrete scaling, ownership, deployment, workload isolation, or security reason.

## API Documentation

OpenAPI documentation lives in:

```text
src/docs/openapi.ts
```

`src/app.ts` serves the raw spec at `GET /openapi.json` and Swagger UI at `/docs`. Keep the OpenAPI document in sync when routes, request params, status codes, or response contracts change.

## BaseRepository

Location:

```text
src/repositories/base.repository.ts
```

Kept methods:

- `executeQuery`
- `executeSingleQuery`
- `executeSingleQueryOrThrow`
- `log`

Repositories stay raw SQL-first. Do not add an ORM.

Repository SQL text is centralized in:

```text
src/db/sql-queries.ts
```

Repositories select queries by key and pass all runtime values through parameter arrays (`$1`, `$2`, etc.). Do not concatenate request input, route params, domains, provider names, limits, JSON payloads, or statuses into SQL strings.

## BaseService

Location:

```text
src/services/base.service.ts
```

Kept methods:

- `parseJson`
- `withRetries`
- `roundNumber`
- `average`
- `log`
- `logError`

Use service base helpers only for common backend utilities, not domain logic.

## BaseRouter

Location:

```text
src/routes/base.router.ts
```

Kept methods:

- `asyncHandler`
- `apiHandler`

Routes only map URL patterns to validation middleware and controller methods. `apiHandler` is the common async controller wrapper: it awaits a controller `ApiResult`, sends it with `sendApiResult`, and forwards thrown errors to Express with `next(error)`.

## BaseController

Location:

```text
src/controllers/base.controller.ts
```

Kept methods:

- `logRequest`
- `logResponse`

Controllers call one service method and return the service result.

## Validation Middleware

Location:

```text
src/middleware/validate.middleware.ts
```

Kept functions:

- `validateBody`
- `validateParams`

Routes attach validation middleware before controller handlers. Controllers should assume validated request data.

## API Responses

Location:

```text
src/utils/api-response.ts
src/types/api-response.types.ts
```

Kept helpers:

- `apiResult`
- `apiError`
- `sendApiResult`

Controllers return `ApiResult` values. Routes use `BaseRouter.apiHandler(...)` to send those results through `sendApiResult`.

Do not change existing success response payloads into a new envelope unless the endpoint explicitly requires it. Error responses use the shared shape:

```json
{
  "status": "error",
  "error": "message"
}
```

## Current Layers

```text
routes
  -> validation middleware
  -> apiHandler response wrapper
  -> controllers
  -> services
  -> repositories
  -> PostgreSQL / Redis / Elasticsearch
```

Controller/service split:

```text
AnalysisRouter
  -> AnalysisController
  -> AnalysisCommandService
  -> AnalysisStatusService
  -> AnalysisJobService

ProviderScoresRouter
  -> ProviderScoresController
  -> ProviderScoresService

VisibilityScoresRouter
  -> VisibilityScoresController
  -> VisibilityScoreReadService

DiffEngineService
  -> AnalysisDiffsRepository
```

Keep this split unless a service has a clear reason to own the dependency. Do not put all repositories, Redis, and BullMQ into one API facade.

## Shared Types

Shared contracts live in `src/types`.

```text
src/types/database.types.ts
src/types/provider.types.ts
src/types/queue.types.ts
src/types/observability.types.ts
```

Keep tiny implementation-only types near the file that uses them. Examples:

- provider HTTP response shapes
- prompt JSON parser shapes
- constructor dependency shapes

Worker flow:

```text
runtime/analysis-worker.ts
  -> modules/analysis/AnalysisJobService
  -> modules/providers/ProviderExecutionService
  -> module repositories + VisibilityScoreService + ObservabilityIndexService + DiffEngineService
```

Additional workers:

```text
runtime/scheduler-worker.ts
  -> modules/scheduler/DomainSchedulerService
  -> domain_schedules + analysis_runs + domain-analysis queue

runtime/notification-worker.ts
  -> modules/notifications/NotificationService
  -> notifications
```

`ObservabilityIndexService` is exported from the Elasticsearch observability module. Index names and mappings live in `src/modules/observability/elasticsearch/observability-index-definitions.ts`, while the service implementation lives in `src/modules/observability/elasticsearch/elasticsearch-observability.service.ts`. Elasticsearch is observability-only, so index setup or trace write failures are logged and must not fail the PostgreSQL workflow.

`ProviderExecutionService` owns provider prompt execution and uses `BaseService.withRetries`; retry count comes from `PROVIDER_MAX_RETRIES`.

`DiffEngineService` compares the current run-linked `visibility_scores` and `provider_snapshots` rows against the previous successful run for the same domain, then stores changes in `analysis_diffs`.
