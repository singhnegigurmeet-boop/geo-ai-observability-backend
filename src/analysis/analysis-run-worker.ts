import type {
  AnalysisRunExpansionResult,
  AnalysisRunExpansionService
} from "./analysis-run-expansion.service.js";
import {
  parseAnalysisRunCreatedMessage,
  type AnalysisRunCreatedMessage
} from "./analysis-run-worker.messages.js";

export interface AnalysisRunExpander {
  expand(
    payload: AnalysisRunCreatedMessage["payload"]
  ): Promise<AnalysisRunExpansionResult>;
}

export class AnalysisRunWorker {
  constructor(
    private readonly expansion: Pick<AnalysisRunExpansionService, "expand">
  ) {}

  async process(input: unknown) {
    const message = parseAnalysisRunCreatedMessage(input);
    return this.expansion.expand(message.payload);
  }
}
