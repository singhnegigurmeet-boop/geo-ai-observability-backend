import type { ProviderName } from "../../../common/types/database.types.js";
import type { ProviderExecutionService } from "../services/provider-execution.service.js";
import { parseProviderJobCreatedMessage } from "../messages/provider-worker.messages.js";

export class ProviderWorker {
  constructor(
    private readonly expectedProvider: ProviderName,
    private readonly execution: Pick<ProviderExecutionService, "execute">
  ) {}

  async process(input: unknown) {
    const message = parseProviderJobCreatedMessage(input);
    return this.execution.execute(message.payload, this.expectedProvider);
  }
}
