import { parseClassificationJobCreatedMessage } from "../messages/classification-worker.messages.js";
import type { ClassificationPlanningService } from "../services/classification-planning.service.js";

export class ClassificationWorker {
  constructor(
    private readonly planning: Pick<ClassificationPlanningService, "plan">
  ) {}

  async process(input: unknown) {
    const message = parseClassificationJobCreatedMessage(input);
    return this.planning.plan(message.payload);
  }
}
