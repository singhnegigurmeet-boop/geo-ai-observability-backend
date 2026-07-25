import type { PromptType } from "../../../common/types/database.types.js";
import type { PromptExecutionService } from "../services/prompt-execution.service.js";
import { parsePromptJobCreatedMessage } from "../messages/prompt-worker.messages.js";

export class PromptWorker {
  constructor(
    private readonly promptType: PromptType,
    private readonly execution: Pick<PromptExecutionService, "execute">
  ) {}

  async process(input: unknown) {
    const message = parsePromptJobCreatedMessage(input);
    return this.execution.execute(message.payload, this.promptType);
  }
}
