import type { MockProviderService } from "./mock-provider.service.js";
import { parseProviderJobCreatedMessage } from "./provider-worker.messages.js";

export class MockProviderWorker {
  constructor(
    private readonly provider: Pick<MockProviderService, "execute">
  ) {}

  async process(input: unknown) {
    const message = parseProviderJobCreatedMessage(input);
    return this.provider.execute(message.payload);
  }
}
