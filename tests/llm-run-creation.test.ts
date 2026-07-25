import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidAnalysisRunItemMessageError,
  parseAnalysisRunItemCreatedMessage
} from "../src/analysis/analysis-run-item-worker.messages.js";

describe("analysis_run_item.created message validation", () => {
  it("accepts a valid message", () => {
    const message = validEnvelope();
    assert.deepEqual(parseAnalysisRunItemCreatedMessage(message), message);
  });

  for (const required of [
    "analysisRunItemId",
    "analysisRunId",
    "entityPathId"
  ] as const) {
    it(`rejects missing ${required}`, () => {
      const message = validEnvelope();
      const payload = { ...message.payload };
      delete payload[required];
      assert.throws(
        () => parseAnalysisRunItemCreatedMessage({ ...message, payload }),
        InvalidAnalysisRunItemMessageError
      );
    });
  }

  it("rejects inconsistent actor ownership", () => {
    const message = validEnvelope();
    assert.throws(
      () =>
        parseAnalysisRunItemCreatedMessage({
          ...message,
          payload: {
            ...message.payload,
            actorType: "user",
            userId: null,
            workspaceId: null
          }
        }),
      /ownership fields/
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
    payload: {
      analysisRunItemId: "4",
      analysisRunId: "1",
      entityPathId: "2",
      startingEntityPathId: "3",
      actorType: "anonymous" as const,
      userId: null,
      workspaceId: null,
      anonymousSessionId: "5"
    }
  };
}
