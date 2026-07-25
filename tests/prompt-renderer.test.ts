import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PromptRendererService } from "../src/prompts/prompt-renderer.service.js";
import type { PromptRenderingContext } from "../src/prompts/prompt-rendering.types.js";
import type { PromptType } from "../src/types/database.types.js";

const promptTypes: PromptType[] = [
  "competitor",
  "ranking",
  "visibility",
  "price_range",
  "pros_cons"
];

describe("Phase 8 prompt renderer", () => {
  it("renders every v1 prompt deterministically from canonical DB context", () => {
    const renderer = new PromptRendererService();
    for (const promptType of promptTypes) {
      const context = renderingContext(promptType, "user");
      const first = renderer.render(context);
      assert.equal(renderer.render(context), first);
      assert.ok(first.trim().length > 0);
      assert.match(first, /domain=example\.com/);
      assert.match(first, /category=Software/);
      assert.match(first, /brand=Example Brand/);
      assert.doesNotMatch(first, /RAW-USER-INPUT/);
    }
  });

  it("preserves actor-aware rendering and rejects unknown versions", () => {
    const renderer = new PromptRendererService();
    const anonymous = renderer.render(
      renderingContext("visibility", "anonymous")
    );
    const user = renderer.render(renderingContext("visibility", "user"));
    assert.notEqual(anonymous, user);
    assert.ok(anonymous.length < user.length);
    assert.match(anonymous, /actor_policy=anonymous/);
    assert.match(user, /actor_policy=user/);
    assert.throws(
      () =>
        renderer.render({
          ...renderingContext("visibility", "user"),
          promptVersion: "v2" as "v1" | "v1_light"
        }),
      /Unsupported prompt template/
    );
  });
});

function renderingContext(
  promptType: PromptType,
  actorType: "anonymous" | "user"
): PromptRenderingContext {
  return {
    promptType,
    promptVersion: actorType === "anonymous" ? "v1_light" : "v1",
    actorType,
    normalizedDomain: "example.com",
    pathType: "brand",
    categoryName: "Software",
    brandName: "Example Brand",
    productName: null,
    useContextName: null
  };
}
