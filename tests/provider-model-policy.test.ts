import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidProviderModelSelectionError,
  resolveProviderModelSet
} from "../src/providers/provider-model.policy.js";

describe("provider-set policy", () => {
  it("uses fixed actor defaults", () => {
    assert.deepEqual(resolveProviderModelSet({ actorType: "anonymous" }), [
      { provider: "mock", model: "mock-fast", queueName: "mock_queue" }
    ]);
    assert.deepEqual(resolveProviderModelSet({ actorType: "user" }), [
      { provider: "mock", model: "mock-standard", queueName: "mock_queue" }
    ]);
  });

  it("rejects every explicit anonymous set, including an empty set", () => {
    for (const providerModels of [
      [],
      [{ provider: "mock" as const, model: "mock-fast" }]
    ]) {
      assert.throws(
        () => resolveProviderModelSet({ actorType: "anonymous", providerModels }),
        InvalidProviderModelSelectionError
      );
    }
  });

  it("validates exact provider/model pairs and real-provider gating", () => {
    for (const pair of [
      { provider: "mock" as const, model: "unknown" },
      { provider: "openai" as const, model: "gemini-1.5-flash" },
      { provider: "openai" as const, model: "gpt-4o-mini" }
    ]) {
      assert.throws(
        () =>
          resolveProviderModelSet({
            actorType: "user",
            providerModels: [pair]
          }),
        InvalidProviderModelSelectionError
      );
    }
    assert.deepEqual(
      resolveProviderModelSet({
        actorType: "user",
        providerModels: [
          { provider: "openai", model: "gpt-4o-mini" },
          { provider: "gemini", model: "gemini-1.5-flash" },
          { provider: "claude", model: "claude-3-5-sonnet" }
        ],
        realProvidersEnabled: true
      }).map(({ provider, model }) => ({ provider, model })),
      [
        { provider: "claude", model: "claude-3-5-sonnet" },
        { provider: "gemini", model: "gemini-1.5-flash" },
        { provider: "openai", model: "gpt-4o-mini" }
      ]
    );
  });

  it("normalizes, deduplicates, and stably sorts an explicit set", () => {
    assert.deepEqual(
      resolveProviderModelSet({
        actorType: "user",
        providerModels: [
          { provider: "openai", model: "gpt-4o-mini" },
          { provider: "mock", model: "mock-quality" },
          { provider: "openai", model: "gpt-4o-mini" }
        ],
        realProvidersEnabled: true
      }).map(({ provider, model }) => ({ provider, model })),
      [
        { provider: "mock", model: "mock-quality" },
        { provider: "openai", model: "gpt-4o-mini" }
      ]
    );
  });

  it("enforces the maximum final set size", () => {
    assert.throws(
      () =>
        resolveProviderModelSet({
          actorType: "user",
          providerModels: Array.from({ length: 5 }, () => ({
            provider: "mock" as const,
            model: "mock-fast"
          }))
        }),
      InvalidProviderModelSelectionError
    );
  });
});
