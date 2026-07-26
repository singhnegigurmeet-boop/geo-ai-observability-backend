import type { PromptRenderingContext } from "../types/prompt-rendering.types.js";

export function canonicalPath(context: PromptRenderingContext) {
  return context.entityPathContext.canonicalPath;
}

export function responseContract() {
  return [
    "Return a concise JSON object with an evidence array and summary.",
    "Each evidence item must contain claim, source, and confidence.",
    "Do not invent URLs or claim access to private data."
  ].join(" ");
}
