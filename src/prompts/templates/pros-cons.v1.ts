import type { PromptTemplate } from "../prompt-rendering.types.js";
import { canonicalPath, responseContract } from "./template-context.js";

export const renderProsConsV1: PromptTemplate = (context) =>
  [
    "Identify strengths, weaknesses, pros, and cons surfaced in AI-generated answers",
    `for this canonical entity path: ${canonicalPath(context)}.`,
    "Separate supported advantages from supported limitations.",
    responseContract()
  ].join(" ");
