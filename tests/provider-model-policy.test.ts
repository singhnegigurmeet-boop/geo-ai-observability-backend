import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectProviderModel } from "../src/providers/provider-model.policy.js";

describe("Phase 8 provider/model policy", () => {
  it("keeps provider, provider-owned model, and queue distinct", () => {
    assert.deepEqual(selectProviderModel(), {
      provider: "mock",
      model: "mock-fast",
      queueName: "mock_queue"
    });
  });
});
