import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidAnalysisRunMessageError,
  parseAnalysisRunCreatedMessage
} from "../src/analysis/analysis-run-worker.messages.js";

describe("analysis_run.created message validation", () => {
  it("accepts the aggregate-ID-only contract", () => {
    const message = validMessage();
    assert.deepEqual(parseAnalysisRunCreatedMessage(message), message);
  });

  it("rejects missing analysisRunId", () => {
    const message = validMessage();
    const { analysisRunId: _, ...payload } = message.payload;
    assert.throws(
      () => parseAnalysisRunCreatedMessage({ ...message, payload }),
      InvalidAnalysisRunMessageError
    );
  });

  it("rejects duplicated business state", () => {
    const message = validMessage();
    assert.throws(
      () =>
        parseAnalysisRunCreatedMessage({
          ...message,
          payload: {
            ...message.payload,
            actorType: "user"
          }
        }),
      InvalidAnalysisRunMessageError
    );
  });

  it("rejects the wrong event type and mismatched aggregate ID", () => {
    const message = validMessage();
    assert.throws(
      () =>
        parseAnalysisRunCreatedMessage({
          ...message,
          eventType: "analysis_run_item.created"
        }),
      InvalidAnalysisRunMessageError
    );
    assert.throws(
      () => parseAnalysisRunCreatedMessage({ ...message, aggregateId: "99" }),
      /aggregateId/
    );
  });
});

function validMessage() {
  return {
    messageId: "analysis_run.created:1",
    eventType: "analysis_run.created",
    aggregateType: "analysis_run",
    aggregateId: "1",
    occurredAt: "2026-07-25T00:00:00.000Z",
    attempt: 1,
    payload: { analysisRunId: "1" }
  };
}
