import {
  parseLlmRunCreatedMessage
} from "../messages/llm-run-worker.messages.js";
import type { PromptPlanningService } from "../../prompts/services/prompt-planning.service.js";

export class LlmRunWorker {
  constructor(
    private readonly prompts: Pick<PromptPlanningService, "plan">
  ) {}

  async process(input: unknown) {
    const message = parseLlmRunCreatedMessage(input);
    return this.prompts.plan(message.payload);
  }
}
