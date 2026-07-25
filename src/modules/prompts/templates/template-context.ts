import type { PromptRenderingContext } from "../types/prompt-rendering.types.js";

export function canonicalPath(context: PromptRenderingContext) {
  return [
    `domain=${context.normalizedDomain}`,
    `actor_policy=${context.actorType}`,
    context.categoryName ? `category=${context.categoryName}` : null,
    context.brandName ? `brand=${context.brandName}` : null,
    context.productName ? `product=${context.productName}` : null,
    context.useContextName ? `use_context=${context.useContextName}` : null
  ]
    .filter((part): part is string => part !== null)
    .join("; ");
}

export function responseContract() {
  return [
    "Return a concise JSON object with an evidence array and summary.",
    "Each evidence item must contain claim, source, and confidence.",
    "Do not invent URLs or claim access to private data."
  ].join(" ");
}
