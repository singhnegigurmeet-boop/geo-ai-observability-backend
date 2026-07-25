import type { PromptTemplate } from "../types/prompt-rendering.types.js";
import { canonicalPath, responseContract } from "./template-context.js";

export const renderRankingV1: PromptTemplate = (context) =>
  [
    "Assess the relative position of the target against relevant competitors",
    `for this canonical entity path: ${canonicalPath(context)}.`,
    "Describe comparative prominence and the evidence supporting that ordering.",
    responseContract()
  ].join(" ");
