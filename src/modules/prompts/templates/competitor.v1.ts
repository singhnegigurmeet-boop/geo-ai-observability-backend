import type { PromptTemplate } from "../types/prompt-rendering.types.js";
import { canonicalPath, responseContract } from "./template-context.js";

export const renderCompetitorV1: PromptTemplate = (context) =>
  [
    "Identify relevant competing brands, products, or authoritative sources",
    `for this canonical entity path: ${canonicalPath(context)}.`,
    "Focus on entities likely to appear beside the target in AI-assisted discovery.",
    responseContract()
  ].join(" ");
