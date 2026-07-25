import type { ProviderName } from "../../../common/types/database.types.js";
import type { ProviderAdapter } from "../types/provider-adapter.types.js";
import { ProviderExecutionError } from "../errors/provider-execution.error.js";

export class ProviderAdapterRegistry {
  private readonly adapters: Map<ProviderName, ProviderAdapter>;

  constructor(adapters: ProviderAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  resolve(provider: ProviderName, model: string) {
    const adapter = this.adapters.get(provider);
    if (!adapter || !adapter.supportsModel(model)) {
      throw new ProviderExecutionError(
        "UNSUPPORTED_PROVIDER_MODEL",
        `No enabled adapter supports ${provider}/${model}`,
        true
      );
    }
    return adapter;
  }
}
