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
  -> createApp(route services)
  -> createAnalysisWorker(analysisJobService)
```

Service classes should not create repositories, queues, Redis clients, or Elasticsearch clients internally. They receive dependencies through constructors.

Infrastructure objects are created once and reused:

- PostgreSQL pool: `src/lib/postgres.ts`
- Redis connection: `src/lib/redis.ts`
- BullMQ queue: `src/queue/analysis.queue.ts`
- Elasticsearch client: `src/lib/elasticsearch.ts`
- Repositories: singleton exports in `src/repositories`
- Services: wired once in `src/container.ts`

Do not create database pools, Redis clients, BullMQ queues, repositories, or core services inside request handlers or job handlers.

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

Routes only map URL patterns to controller methods.

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

All controllers should send service results through `sendApiResult`.

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

ProviderScoresRouter
  -> ProviderScoresController
  -> ProviderScoresService

VisibilityScoresRouter
  -> VisibilityScoresController
  -> VisibilityScoreReadService
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
  -> AnalysisJobService
  -> ProviderExecutionService
  -> repositories + VisibilityScoreService + ObservabilityIndexService
```

`ObservabilityIndexService` owns Elasticsearch index setup and trace writes. Elasticsearch is observability-only, so index setup or trace write failures are logged and must not fail the PostgreSQL scoring workflow.

`ProviderExecutionService` owns provider prompt execution and uses `BaseService.withRetries`; retry count comes from `PROVIDER_MAX_RETRIES`.
