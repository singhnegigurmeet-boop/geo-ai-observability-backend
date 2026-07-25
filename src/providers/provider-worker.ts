import type { ProviderName } from "../types/database.types.js";
import type { ProviderExecutionService } from "./provider-execution.service.js";
import { ProviderExecutionError } from "./provider-execution.error.js";
import { parseProviderJobCreatedMessage } from "./provider-worker.messages.js";

export class ProviderWorker {
  constructor(
    private readonly expectedProvider: ProviderName,
    private readonly execution: Pick<ProviderExecutionService, "execute">
  ) {}

  async process(input: unknown) {
    const message = parseProviderJobCreatedMessage(input);
    if (message.payload.provider !== this.expectedProvider) {
      throw new ProviderExecutionError(
        "PROVIDER_QUEUE_MISMATCH",
        `Message provider does not match ${this.expectedProvider} queue`,
        true
      );
    }
    return this.execution.execute(message.payload);
  }
}
