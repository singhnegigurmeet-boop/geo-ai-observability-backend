import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HIERARCHY_DISCOVERY_CONTRACT_VERSIONS,
  HIERARCHY_DISCOVERY_PROMPT_VERSIONS,
  hierarchyDiscoveryResponseSchemas
} from "../../../src/modules/providers/contracts/provider-response.contracts.js";
import { renderDiscoveryPrompt } from "../../../src/modules/discovery/services/hierarchy-discovery.service.js";

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

  it("renders only frozen stage context and version identities", () => {
    const prompt = renderDiscoveryPrompt("use_context", {
      product: { id: "3", name: "Example Product" },
      candidates: [{ id: "7", name: "Travel" }]
    }, HIERARCHY_DISCOVERY_PROMPT_VERSIONS.use_context, HIERARCHY_DISCOVERY_CONTRACT_VERSIONS.use_context);
    assert.match(prompt, /Return strict JSON only/);
    assert.match(prompt, /Do not invent controlled IDs/);
    assert.match(prompt, /Example Product/);
  });
});
