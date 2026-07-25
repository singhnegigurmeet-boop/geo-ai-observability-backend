import type { LlmRunCreationService } from "../llm/llm-run-creation.service.js";
import {
  parseAnalysisRunItemCreatedMessage
} from "./analysis-run-item-worker.messages.js";

export class AnalysisRunItemWorker {
  constructor(
    private readonly llmRuns: Pick<LlmRunCreationService, "create">
  ) {}

  async process(input: unknown) {
    const message = parseAnalysisRunItemCreatedMessage(input);
    return this.llmRuns.create(message.payload);
  }
}
