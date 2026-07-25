import type { ProviderScoreService } from "./provider-score.service.js";
import { parseProviderResultCreatedMessage } from "./provider-score-worker.messages.js";

export class ProviderScoreWorker {
  constructor(
    private readonly scoring: Pick<ProviderScoreService, "process">
  ) {}

  async process(input: unknown) {
    const message = parseProviderResultCreatedMessage(input);
    return this.scoring.process(message.payload);
  }
}
