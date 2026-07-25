import { renderCompetitorV1 } from "./templates/competitor.v1.js";
import { renderPriceRangeV1 } from "./templates/price-range.v1.js";
import { renderProsConsV1 } from "./templates/pros-cons.v1.js";
import { renderRankingV1 } from "./templates/ranking.v1.js";
import { renderVisibilityV1 } from "./templates/visibility.v1.js";
import type {
  PromptRenderingContext,
  PromptTemplate
} from "./prompt-rendering.types.js";

const templates = {
  competitor: renderCompetitorV1,
  ranking: renderRankingV1,
  visibility: renderVisibilityV1,
  price_range: renderPriceRangeV1,
  pros_cons: renderProsConsV1
} satisfies Record<PromptRenderingContext["promptType"], PromptTemplate>;

export class PromptRendererService {
  render(context: PromptRenderingContext) {
    if (context.promptVersion !== "v1") {
      throw new UnsupportedPromptTemplateError(
        context.promptType,
        context.promptVersion
      );
    }
    const rendered = templates[context.promptType](context).trim();
    if (!rendered) {
      throw new Error("Prompt renderer produced blank text");
    }
    return rendered;
  }
}

export class UnsupportedPromptTemplateError extends Error {
  readonly code = "UNSUPPORTED_PROMPT_TEMPLATE";
  readonly permanent = true;

  constructor(promptType: string, promptVersion: string) {
    super(`Unsupported prompt template ${promptType}:${promptVersion}`);
    this.name = "UnsupportedPromptTemplateError";
  }
}
