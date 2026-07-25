import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidPromptJobMessageError,
  parsePromptJobCreatedMessage
} from "../src/prompts/prompt-worker.messages.js";
import { PromptWorker } from "../src/prompts/prompt-worker.js";

describe("prompt_job.created validation and worker", () => {
  it("validates and dispatches a correctly routed message", async () => {
    let received: unknown;
    let expectedType: unknown;
    const worker = new PromptWorker("visibility", {
      async execute(payload, promptType) {
        received = payload;
        expectedType = promptType;
        return { outcome: "enqueued", providerJobId: "8" };
      }
    });
    const result = await worker.process(envelope());
    assert.deepEqual(result, { outcome: "enqueued", providerJobId: "8" });
    assert.deepEqual(received, envelope().payload);
    assert.equal(expectedType, "visibility");
  });

  it("rejects malformed linkage or extra state and supplies queue authority", async () => {
    assert.throws(
      () =>
        parsePromptJobCreatedMessage({
          ...envelope(),
          aggregateId: "999"
        }),
      InvalidPromptJobMessageError
    );
    assert.throws(
      () =>
        parsePromptJobCreatedMessage({
          ...envelope(),
          payload: {
            ...envelope().payload,
            actorType: "anonymous"
          }
        }),
      InvalidPromptJobMessageError
    );
    let expectedType: unknown;
    await new PromptWorker("ranking", {
      async execute(_payload, promptType) {
        expectedType = promptType;
        return { outcome: "noop", providerJobId: null };
      }
    }).process({ ...envelope(), payload: { promptJobId: "5" } });
    assert.equal(expectedType, "ranking");
  });
});

function envelope() {
  return {
    messageId: "prompt_job.created:5",
    eventType: "prompt_job.created",
    aggregateType: "prompt_job",
    aggregateId: "5",
    occurredAt: new Date().toISOString(),
    attempt: 1,
    payload: { promptJobId: "5" }
  } as const;
}
