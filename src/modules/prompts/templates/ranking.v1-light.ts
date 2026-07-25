import type { PromptTemplate } from "../types/prompt-rendering.types.js";
import { canonicalPath } from "./template-context.js";

export const renderRankingV1Light: PromptTemplate = (context) =>
  [
    "Give a concise relative-position assessment",
    `for this canonical entity path: ${canonicalPath(context)}.`,
    "Return concise JSON evidence with claim, source, confidence, and summary."
  ].join(" ");
