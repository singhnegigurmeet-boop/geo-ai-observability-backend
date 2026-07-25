import type { PromptTemplate } from "../types/prompt-rendering.types.js";
import { canonicalPath, responseContract } from "./template-context.js";

export const renderPriceRangeV1: PromptTemplate = (context) =>
  [
    "Assess price or range positioning where it is meaningful",
    `for this canonical entity path: ${canonicalPath(context)}.`,
    "If pricing is not applicable, state that explicitly and explain why.",
    responseContract()
  ].join(" ");
