import type { PromptTemplate } from "../prompt-rendering.types.js";
import { canonicalPath } from "./template-context.js";

export const renderVisibilityV1Light: PromptTemplate = (context) =>
  [
    "Give a concise visibility assessment",
    `for this canonical entity path: ${canonicalPath(context)}.`,
    "Return concise JSON evidence with claim, source, confidence, and summary."
  ].join(" ");
