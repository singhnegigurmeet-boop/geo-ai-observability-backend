import { parseClassificationResultCreatedMessage } from "../messages/classification-result-worker.messages.js";
import type { ClassificationResultService } from "../services/classification-result.service.js";

export class ClassificationResultWorker {
  constructor(
    private readonly results: Pick<ClassificationResultService, "process">
  ) {}

  async process(input: unknown) {
    const message = parseClassificationResultCreatedMessage(input);
    return this.results.process(message.payload);
  }
}
