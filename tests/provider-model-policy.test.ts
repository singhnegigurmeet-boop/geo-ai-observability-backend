import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidProviderModelSelectionError,
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
});
