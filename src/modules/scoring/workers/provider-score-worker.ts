import type { ProviderScoreService } from "../services/provider-score.service.js";
import { parseProviderResultCreatedMessage } from "../messages/provider-score-worker.messages.js";

export class ProviderScoreWorker {
  constructor(
    private readonly scoring: Pick<ProviderScoreService, "process">
  ) {}

  async process(input: unknown) {
    const message = parseProviderResultCreatedMessage(input);
    return this.scoring.process(message.payload);
  }
}
