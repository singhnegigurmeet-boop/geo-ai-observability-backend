import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderScoreWorker } from "../../../src/modules/scoring/workers/provider-score-worker.js";

describe("provider_result.created validation and scoring worker", () => {
  it("validates and dispatches an ID-only result event", async () => {
    let received: unknown;
    const worker = new ProviderScoreWorker({
      async process(payload) {
        received = payload;
        return {
          outcome: "scored" as const,
          providerScoreId: "12",
          reportId: null
        };
      }
    });
    const result = await worker.process(validMessage());
    assert.equal(result.outcome, "scored");
    assert.deepEqual(received, { providerResultId: "7" });
  });

  it("rejects malformed event linkage and additional evidence payload", async () => {
    const worker = new ProviderScoreWorker({
      async process() {
        throw new Error("must not execute");
      }
    });
    await assert.rejects(
      worker.process({
        ...validMessage(),
        aggregateId: "8"
      }),
      { name: "InvalidProviderResultMessageError" }
    );
    await assert.rejects(
      worker.process({
        ...validMessage(),
        payload: {
          ...validMessage().payload,
          evidence: "must not travel through RabbitMQ"
        }
      }),
      { name: "InvalidProviderResultMessageError" }
    );
  });
});

function validMessage() {
  return {
    messageId: "provider_result.created:7",
    eventType: "provider_result.created",
    aggregateType: "provider_result",
    aggregateId: "7",
    occurredAt: new Date().toISOString(),
    attempt: 1,
    payload: { providerResultId: "7" }
  };
}
