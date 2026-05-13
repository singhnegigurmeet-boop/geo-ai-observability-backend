# Base Classes And Dependency Wiring

The backend uses small base classes only where they remove repeated plumbing.

## Composition Root

Runtime dependencies are wired in `src/container.ts`.

`main.ts` imports the ready-to-use services from the container:

```text
main.ts
  -> analysisApiService
  -> analysisJobService
  -> createApp(analysisApiService)
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

- `validateBody`
- `validateParams`
- `asyncHandler`
- `logRequest`
- `logResponse`

Routes should validate input, call one service method, and return the service result.

## Current Layers

```text
routes
  -> services
  -> repositories
  -> PostgreSQL / Redis / Elasticsearch
```

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
