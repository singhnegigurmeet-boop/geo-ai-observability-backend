import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PromptRendererService } from "../../../src/modules/prompts/services/prompt-renderer.service.js";
import type { PromptRenderingContext } from "../../../src/modules/prompts/types/prompt-rendering.types.js";
import type { PromptType } from "../../../src/common/types/database.types.js";
import { promptTypePolicy } from "../../../src/modules/prompts/policies/prompt-policy.registry.js";

const promptTypes: PromptType[] = [
  "competitor",
  "ranking",
  "visibility",
  "price_range",
  "pros_cons"
];

describe("Prompt renderer", () => {
  it("renders every V6 prompt deterministically from canonical DB context", () => {
    const renderer = new PromptRendererService();
    for (const promptType of promptTypes) {
      const context = renderingContext(promptType, "medium");
      const first = renderer.render(context);
      assert.equal(renderer.render(context), first);
      assert.ok(first.trim().length > 0);
      assert.match(first, /website domain: example\.com/);
      assert.match(first, /example\.com > Software > Example Brand/);
      assert.match(first, /exact target: Example Brand/);
      assert.doesNotMatch(first, /RAW-USER-INPUT/);
    }
  });

  it("applies explicit depth limits without changing the response contract", () => {
    const renderer = new PromptRendererService();
    const weak = renderer.render(renderingContext("visibility", "weak"));
    const high = renderer.render(renderingContext("visibility", "high"));
    assert.notEqual(weak, high);
    assert.match(weak, /prompt depth: weak/);
    assert.match(high, /cross-check contradictions/);
    assert.match(weak, /visibility-response-v1/);
    assert.match(high, /visibility-response-v1/);
  });

  it("renders each exact hierarchy level without child-target leakage", () => {
    const renderer = new PromptRendererService();
    for (const level of ["domain", "category", "brand", "product", "use_context"] as const) {
      const entityPathContext = pathContext(level);
      const rendered = renderer.render({
        ...renderingContext("visibility", "weak"),
        entityPathContext
      });
      assert.match(rendered, new RegExp(`target level: ${level}`));
      assert.match(rendered, new RegExp(`exact target: ${entityPathContext.canonicalPath.split(" > ").at(-1)}`));
      if (level === "category") assert.doesNotMatch(rendered, /Example Brand/);
      if (level === "brand") assert.doesNotMatch(rendered, /Example Product/);
      if (level === "product") assert.doesNotMatch(rendered, /Travel Planning/);
    }
  });

  it("rejects a prompt identity not in the active registry", () => {
    assert.throws(
      () => new PromptRendererService().render({
        ...renderingContext("visibility", "weak"),
        businessPromptVersion: "visibility-v0"
      }),
      /Unsupported prompt template/
    );
  });
});

function renderingContext(
  promptType: PromptType,
  promptDepth: "weak" | "medium" | "high"
): PromptRenderingContext {
  return {
    promptType,
    promptDepth,
    businessPromptVersion: promptTypePolicy(promptType).businessPromptVersion,
    responseContractVersion: promptTypePolicy(promptType).responseContractVersion,
    entityPathContext: {
      domain: { id: "1", name: "example.com" },
      category: { id: "2", name: "Software" },
      brand: { id: "3", name: "Example Brand" },
      startingLevel: "domain",
      targetLevel: "brand",
      canonicalPath: "example.com > Software > Example Brand"
    }
  };
}

function pathContext(level: "domain" | "category" | "brand" | "product" | "use_context") {
  const context: PromptRenderingContext["entityPathContext"] = {
    domain: { id: "1", name: "example.com" },
    startingLevel: level,
    targetLevel: level,
    canonicalPath: "example.com"
  };
  if (level !== "domain") context.category = { id: "2", name: "Software" };
  if (["brand", "product", "use_context"].includes(level)) context.brand = { id: "3", name: "Example Brand" };
  if (["product", "use_context"].includes(level)) context.product = { id: "4", name: "Example Product" };
  if (level === "use_context") context.useContext = { id: "5", name: "Travel Planning" };
  context.canonicalPath = [context.domain, context.category, context.brand, context.product, context.useContext]
    .filter((entity): entity is { id: string; name: string } => entity !== undefined)
    .map((entity) => entity.name)
    .join(" > ");
  return context;
}
