import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidAnalysisRunItemMessageError,
  parseAnalysisRunItemCreatedMessage
} from "../../../src/modules/analysis/messages/analysis-run-item-worker.messages.js";

describe("analysis_run_item.created message validation", () => {
  it("accepts a valid message", () => {
    const message = validEnvelope();
    assert.deepEqual(parseAnalysisRunItemCreatedMessage(message), message);
  });

  for (const required of ["analysisRunItemId"] as const) {
    it(`rejects missing ${required}`, () => {
      const message = validEnvelope();
      const payload: Partial<typeof message.payload> = { ...message.payload };
      delete payload[required];
      assert.throws(
        () => parseAnalysisRunItemCreatedMessage({ ...message, payload }),
        InvalidAnalysisRunItemMessageError
      );
    });
  }

  it("rejects duplicated business state", () => {
    const message = validEnvelope();
    assert.throws(
      () =>
        parseAnalysisRunItemCreatedMessage({
          ...message,
          payload: {
            ...message.payload,
            actorType: "user"
          }
        }),
      InvalidAnalysisRunItemMessageError
    );
  });

  it("rejects malformed event type and aggregate linkage", () => {
    const message = validEnvelope();
    assert.throws(
      () =>
        parseAnalysisRunItemCreatedMessage({
          ...message,
          eventType: "llm_run.created"
        }),
      InvalidAnalysisRunItemMessageError
    );
    assert.throws(
      () =>
        parseAnalysisRunItemCreatedMessage({
          ...message,
          aggregateId: "99"
        }),
      /aggregateId/
    );
  });
});

export function validEnvelope() {
  return {
    messageId: "analysis_run_item.created:4",
    eventType: "analysis_run_item.created",
    aggregateType: "analysis_run_item",
    aggregateId: "4",
    occurredAt: "2026-07-25T00:00:00.000Z",
    attempt: 1,
    payload: { analysisRunItemId: "4" }
  };
}
