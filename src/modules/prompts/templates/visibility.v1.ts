import type { PromptTemplate } from "../types/prompt-rendering.types.js";
import { canonicalPath, responseContract } from "./template-context.js";

export const renderVisibilityV1: PromptTemplate = (context) =>
  [
    "Assess how visible and discoverable the selected entity is in AI-generated answers",
    `for this canonical entity path: ${canonicalPath(context)}.`,
    "Focus on mentions, relevance, and likely discovery coverage.",
    responseContract()
  ].join(" ");
