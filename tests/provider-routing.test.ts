import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderWorker } from "../src/providers/provider-worker.js";
import { ProviderExecutionError } from "../src/providers/provider-execution.error.js";

describe("real provider worker routing", () => {
  it("dispatches each exact provider/model envelope", async () => {
    for (const [provider, model] of [
      ["openai", "gpt-4o-mini"],
      ["gemini", "gemini-1.5-flash"],
      ["claude", "claude-3-5-sonnet"]
    ] as const) {
      let received: unknown;
      const worker = new ProviderWorker(provider, {
        async execute(payload) {
          received = payload;
          return { outcome: "completed", providerResultId: "7" };
        }
      });
      const message = envelope(provider, model);
      assert.equal((await worker.process(message)).outcome, "completed");
      assert.deepEqual(received, message.payload);
    }
  });

  it("permanently rejects cross-queue deliveries", async () => {
    await assert.rejects(
      new ProviderWorker("openai", {
        async execute() {
          throw new Error("must not execute");
        }
      }).process(envelope("gemini", "gemini-1.5-flash")),
      (error: unknown) =>
        error instanceof ProviderExecutionError &&
        error.code === "PROVIDER_QUEUE_MISMATCH" &&
        error.permanent
    );
  });
});

function envelope(
  provider: "openai" | "gemini" | "claude",
  model: "gpt-4o-mini" | "gemini-1.5-flash" | "claude-3-5-sonnet"
) {
  return {
    messageId: "provider_job.created:1",
    eventType: "provider_job.created",
    aggregateType: "provider_job",
    aggregateId: "1",
    occurredAt: new Date().toISOString(),
    attempt: 1,
    payload: {
      providerJobId: "1",
      promptJobId: "2",
      provider,
      model
    }
  };
}
