import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockProviderWorker } from "../src/providers/mock-provider-worker.js";
import {
  InvalidProviderJobMessageError,
  parseProviderJobCreatedMessage
} from "../src/providers/provider-worker.messages.js";

describe("provider_job.created validation and mock worker", () => {
  it("validates and dispatches mock/mock-fast work", async () => {
    let received: unknown;
    const worker = new MockProviderWorker({
      async execute(payload) {
        received = payload;
        return { outcome: "completed", providerResultId: "9" };
      }
    });
    assert.deepEqual(await worker.process(envelope()), {
      outcome: "completed",
      providerResultId: "9"
    });
    assert.deepEqual(received, envelope().payload);
  });

  it("rejects malformed aggregate linkage and unexpected payload data", () => {
    for (const invalid of [
      { ...envelope(), aggregateId: "999" },
      {
        ...envelope(),
        payload: { ...envelope().payload, rawPrompt: "unsafe" }
      }
    ]) {
      assert.throws(
        () => parseProviderJobCreatedMessage(invalid),
        InvalidProviderJobMessageError
      );
    }
  });
});

function envelope() {
  return {
    messageId: "provider_job.created:8",
    eventType: "provider_job.created",
    aggregateType: "provider_job",
    aggregateId: "8",
    occurredAt: new Date().toISOString(),
    attempt: 1,
    payload: { providerJobId: "8" }
  } as const;
}
