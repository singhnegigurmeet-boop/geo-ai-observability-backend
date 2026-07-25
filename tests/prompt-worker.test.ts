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
    const worker = new PromptWorker("visibility", {
      async execute(payload) {
        received = payload;
        return { outcome: "enqueued", providerJobId: "8" };
      }
    });
    const result = await worker.process(envelope());
    assert.deepEqual(result, { outcome: "enqueued", providerJobId: "8" });
    assert.deepEqual(received, envelope().payload);
  });

  it("rejects malformed linkage, ownership, and cross-queue prompt types", async () => {
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
            actorType: "anonymous",
            userId: "1"
          }
        }),
      InvalidPromptJobMessageError
    );
    await assert.rejects(
      new PromptWorker("ranking", {
        async execute() {
          return { outcome: "noop", providerJobId: null };
        }
      }).process(envelope()),
      InvalidPromptJobMessageError
    );
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
    payload: {
      promptJobId: "5",
      llmRunId: "4",
      analysisRunItemId: "3",
      analysisRunId: "2",
      entityPathId: "1",
      startingEntityPathId: "1",
      promptType: "visibility",
      promptVersion: "v1",
      actorType: "anonymous",
      userId: null,
      workspaceId: null,
      anonymousSessionId: "7"
    }
  } as const;
}
