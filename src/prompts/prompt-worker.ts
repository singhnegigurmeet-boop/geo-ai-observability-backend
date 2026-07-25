import type { PromptType } from "../types/database.types.js";
import type { PromptExecutionService } from "./prompt-execution.service.js";
import {
  InvalidPromptJobMessageError,
  parsePromptJobCreatedMessage
} from "./prompt-worker.messages.js";

export class PromptWorker {
  constructor(
    private readonly promptType: PromptType,
    private readonly execution: Pick<PromptExecutionService, "execute">
  ) {}

  async process(input: unknown) {
    const message = parsePromptJobCreatedMessage(input);
    if (message.payload.promptType !== this.promptType) {
      throw new InvalidPromptJobMessageError(
        `Expected ${this.promptType} prompt work`
      );
    }
    return this.execution.execute(message.payload);
  }
}
