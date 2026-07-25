import {
  parseLlmRunCreatedMessage
} from "./llm-run-worker.messages.js";
import type { PromptPlanningService } from "../prompts/prompt-planning.service.js";

export class LlmRunWorker {
  constructor(
    private readonly prompts: Pick<PromptPlanningService, "plan">
  ) {}

  async process(input: unknown) {
    const message = parseLlmRunCreatedMessage(input);
    return this.prompts.plan(message.payload);
  }
}
