import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderWorker } from "../src/providers/provider-worker.js";

describe("real provider worker routing", () => {
  it("dispatches an ID-only envelope with queue provider authority", async () => {
    for (const provider of ["openai", "gemini", "claude"] as const) {
      let received: unknown;
      let expected: unknown;
      const worker = new ProviderWorker(provider, {
        async execute(payload, expectedProvider) {
          received = payload;
          expected = expectedProvider;
          return { outcome: "completed", providerResultId: "7" };
        }
      });
      const message = envelope();
      assert.equal((await worker.process(message)).outcome, "completed");
      assert.deepEqual(received, message.payload);
      assert.equal(expected, provider);
    }
  });

  it("rejects duplicated provider claims in new messages", async () => {
    await assert.rejects(
      new ProviderWorker("openai", {
        async execute() {
          return { outcome: "noop", providerResultId: null };
        }
      }).process({
        ...envelope(),
        payload: { providerJobId: "1", provider: "gemini", unexpected: true }
      })
    );
  });
});

function envelope() {
  return {
    messageId: "provider_job.created:1",
    eventType: "provider_job.created",
    aggregateType: "provider_job",
    aggregateId: "1",
    occurredAt: new Date().toISOString(),
    attempt: 1,
    payload: {
      providerJobId: "1"
    }
  };
}
