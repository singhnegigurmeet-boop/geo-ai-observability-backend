import type {
  DatabaseExecutor,
  TransactionPool
} from "../db/database-executor.js";
import { MockProviderAdapter } from "./mock.provider-adapter.js";
import { ProviderAdapterRegistry } from "./provider-adapter.registry.js";
import {
  ProviderExecutionService,
  type ProviderExecutionOutcome
} from "./provider-execution.service.js";
import { ProviderExecutionError } from "./provider-execution.error.js";
import type { ProviderJobCreatedPayload } from "./provider-worker.messages.js";

type MockProviderDatabase = DatabaseExecutor & TransactionPool;

export type MockProviderResult = ProviderExecutionOutcome;
export { ProviderExecutionError as MockProviderExecutionError };

export class MockProviderService {
  private readonly provider: ProviderExecutionService;

  constructor(database: MockProviderDatabase) {
    this.provider = new ProviderExecutionService(
      database,
      new ProviderAdapterRegistry([new MockProviderAdapter()]),
      1_000
    );
  }

  execute(payload: ProviderJobCreatedPayload) {
    return this.provider.execute(payload);
  }
}
