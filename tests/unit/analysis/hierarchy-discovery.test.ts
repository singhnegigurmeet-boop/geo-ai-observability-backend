import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HIERARCHY_DISCOVERY_CONTRACT_VERSIONS,
  HIERARCHY_DISCOVERY_PROMPT_VERSIONS,
  hierarchyDiscoveryResponseSchemas
} from "../../../src/modules/providers/contracts/provider-response.contracts.js";
import { renderDiscoveryPrompt } from "../../../src/modules/discovery/services/hierarchy-discovery.service.js";
import type { HierarchyDiscoveryStage, JsonObject } from "../../../src/common/types/database.types.js";

describe("pre-analysis hierarchy discovery", () => {
  it("defines a strict, versioned response contract for every stage", () => {
    assert.deepEqual(Object.keys(hierarchyDiscoveryResponseSchemas), [
      "category", "brand", "product", "use_context"
    ]);
    assert.equal(hierarchyDiscoveryResponseSchemas.category.safeParse({
      prompt_type: "hierarchy_discovery_category",
      contract_version: HIERARCHY_DISCOVERY_CONTRACT_VERSIONS.category,
      selections: [{ category_id: "1", rank: 1, confidence: 0.9, reason: "Relevant" }],
      summary: "One match"
    }).success, true);
    assert.equal(hierarchyDiscoveryResponseSchemas.brand.safeParse({
      prompt_type: "hierarchy_discovery_brand",
      contract_version: HIERARCHY_DISCOVERY_CONTRACT_VERSIONS.brand,
      items: [{ name: "Example Brand", rank: 2, confidence: 0.8, reason: "Known" }],
      summary: "Invalid non-contiguous rank"
    }).success, false);
  });

  it("renders each immediate-child task from only its exact frozen ancestry", () => {
    const cases: Array<[HierarchyDiscoveryStage, JsonObject, RegExp, RegExp]> = [
      ["category", { domain: { id: "1", name: "example.com" }, candidates: [{ id: "7", name: "Software" }], maximumResults: 3 }, /categories/, /Do not return brands, products, or use contexts/],
      ["brand", { domain: { id: "1", name: "example.com" }, category: { id: "7", name: "Software" }, maximumResults: 3 }, /brand names/, /Do not return products or use contexts/],
      ["product", { domain: { id: "1", name: "example.com" }, category: { id: "7", name: "Software" }, brand: { id: "8", name: "Example Brand" }, maximumResults: 5 }, /product names/, /Do not return use contexts/],
      ["use_context", { domain: { id: "1", name: "example.com" }, category: { id: "7", name: "Software" }, brand: { id: "8", name: "Example Brand" }, product: { id: "9", name: "Example Product" }, candidates: [{ id: "10", name: "Travel" }], maximumResults: 5 }, /use contexts/, /using only use_context_id/]
    ];
    for (const [stage, context, task, exclusion] of cases) {
      const prompt = renderDiscoveryPrompt(stage, context, HIERARCHY_DISCOVERY_PROMPT_VERSIONS[stage], HIERARCHY_DISCOVERY_CONTRACT_VERSIONS[stage]);
      assert.match(prompt, task);
      assert.match(prompt, exclusion);
      assert.match(prompt, new RegExp(`Return at most ${context.maximumResults} results`));
      assert.match(prompt, /Backend candidate IDs and hierarchy context are authoritative/);
      assert.ok(prompt.endsWith(`Authoritative context: ${JSON.stringify(context)}`));
    }
  });

  it("rejects unsupported frozen discovery identity and breadth", () => {
    const context = {
      domain: { id: "1", name: "example.com" },
      category: { id: "2", name: "Software" },
      maximumResults: 3
    };
    assert.throws(() => renderDiscoveryPrompt("brand", { ...context, maximumResults: 6 }, HIERARCHY_DISCOVERY_PROMPT_VERSIONS.brand, HIERARCHY_DISCOVERY_CONTRACT_VERSIONS.brand), /breadth is invalid/);
    assert.throws(() => renderDiscoveryPrompt("brand", context, "hierarchy-discovery-brand-v0", HIERARCHY_DISCOVERY_CONTRACT_VERSIONS.brand), /identity is unsupported/);
  });
});
