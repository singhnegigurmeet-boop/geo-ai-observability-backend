import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidProviderModelSelectionError,
  resolveProviderModelSet,
  selectProviderModel
} from "../src/providers/provider-model.policy.js";

describe("Phase 8 provider/model policy", () => {
  it("uses the cheap fixed anonymous model", () => {
    assert.deepEqual(selectProviderModel({
      actorType: "anonymous",
      requestedProvider: null,
      requestedModel: null
    }), {
      provider: "mock",
      model: "mock-fast",
      queueName: "mock_queue"
    });
  });

  it("uses the user default or an allowed selected model", () => {
    assert.equal(
      selectProviderModel({
        actorType: "user",
        requestedProvider: "mock",
        requestedModel: null
      }).model,
      "mock-standard"
    );
    for (const model of ["mock-fast", "mock-standard", "mock-quality"]) {
      assert.equal(
        selectProviderModel({
          actorType: "user",
          requestedProvider: "mock",
          requestedModel: model
        }).model,
        model
      );
    }
  });

  it("rejects anonymous selection and unsupported user selections", () => {
    for (const context of [
      {
        actorType: "anonymous" as const,
        requestedProvider: "mock" as const,
        requestedModel: "mock-fast"
      },
      {
        actorType: "user" as const,
        requestedProvider: "openai" as const,
        requestedModel: "gpt-4o-mini"
      },
      {
        actorType: "user" as const,
        requestedProvider: "mock" as const,
        requestedModel: "arbitrary"
      }
    ]) {
      assert.throws(
        () => selectProviderModel(context),
        InvalidProviderModelSelectionError
      );
    }
  });

  it("allows one exact real model per provider only when enabled", () => {
    for (const [provider, model, queueName] of [
      ["openai", "gpt-4o-mini", "openai_queue"],
      ["gemini", "gemini-1.5-flash", "gemini_queue"],
      ["claude", "claude-3-5-sonnet", "claude_queue"]
    ] as const) {
      assert.deepEqual(
        selectProviderModel({
          actorType: "user",
          requestedProvider: provider,
          requestedModel: model,
          realProvidersEnabled: true
        }),
        { provider, model, queueName }
      );
      assert.throws(
        () =>
          selectProviderModel({
            actorType: "user",
            requestedProvider: provider,
            requestedModel: model
          }),
        InvalidProviderModelSelectionError
      );
    }
  });

  it("normalizes, deduplicates, and stably sorts an explicit provider set", () => {
    assert.deepEqual(
      resolveProviderModelSet({
        actorType: "user",
        requestedProvider: null,
        requestedModel: null,
        requestedProviderModels: [
          { provider: "openai", model: "gpt-4o-mini" },
          { provider: "claude", model: "claude-3-5-sonnet" },
          { provider: "openai", model: "gpt-4o-mini" },
          { provider: "gemini", model: "gemini-1.5-flash" }
        ],
        realProvidersEnabled: true
      }),
      [
        {
          provider: "claude",
          model: "claude-3-5-sonnet",
          queueName: "claude_queue"
        },
        {
          provider: "gemini",
          model: "gemini-1.5-flash",
          queueName: "gemini_queue"
        },
        {
          provider: "openai",
          model: "gpt-4o-mini",
          queueName: "openai_queue"
        }
      ]
    );
  });
});
