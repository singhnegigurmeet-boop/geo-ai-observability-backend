import type { PromptTemplate } from "../types/prompt-rendering.types.js";
import { canonicalPath } from "./template-context.js";

export const renderCompetitorV1Light: PromptTemplate = (context) =>
  [
    "List up to three likely competitors",
    `for this canonical entity path: ${canonicalPath(context)}.`,
    "Return concise JSON evidence with claim, source, confidence, and summary."
  ].join(" ");
