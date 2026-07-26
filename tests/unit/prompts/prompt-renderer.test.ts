import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PromptRendererService } from "../../../src/modules/prompts/services/prompt-renderer.service.js";
import type { PromptRenderingContext } from "../../../src/modules/prompts/types/prompt-rendering.types.js";
import type { PromptType } from "../../../src/common/types/database.types.js";

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
});

function renderingContext(
  promptType: PromptType,
  promptDepth: "weak" | "medium" | "high"
): PromptRenderingContext {
  return {
    promptType,
    promptDepth,
    businessPromptVersion: `${promptType}-v1`,
    responseContractVersion:
      promptType === "price_range"
        ? "price-range-response-v1"
        : promptType === "pros_cons"
          ? "pros-cons-response-v1"
          : `${promptType}-response-v1`,
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
