import { renderCompetitorV1 } from "../templates/competitor.v1.js";
import { renderCompetitorV1Light } from "../templates/competitor.v1-light.js";
import { renderPriceRangeV1 } from "../templates/price-range.v1.js";
import { renderProsConsV1 } from "../templates/pros-cons.v1.js";
import { renderRankingV1 } from "../templates/ranking.v1.js";
import { renderRankingV1Light } from "../templates/ranking.v1-light.js";
import { renderVisibilityV1 } from "../templates/visibility.v1.js";
import { renderVisibilityV1Light } from "../templates/visibility.v1-light.js";
import type {
  PromptRenderingContext,
  PromptTemplate
} from "../types/prompt-rendering.types.js";

const templates = {
  "competitor:v1": renderCompetitorV1,
  "competitor:v1_light": renderCompetitorV1Light,
  "ranking:v1": renderRankingV1,
  "ranking:v1_light": renderRankingV1Light,
  "visibility:v1": renderVisibilityV1,
  "visibility:v1_light": renderVisibilityV1Light,
  "price_range:v1": renderPriceRangeV1,
  "pros_cons:v1": renderProsConsV1
} satisfies Record<string, PromptTemplate>;

export class PromptRendererService {
  render(context: PromptRenderingContext) {
    const expectedVersion =
      context.actorType === "anonymous" ? "v1_light" : "v1";
    const template = templates[
      `${context.promptType}:${context.promptVersion}` as keyof typeof templates
    ];
    if (context.promptVersion !== expectedVersion || !template) {
      throw new UnsupportedPromptTemplateError(
        context.promptType,
        context.promptVersion
      );
    }
    const rendered = template(context).trim();
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
