import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidLlmRunMessageError,
  parseLlmRunCreatedMessage
} from "../src/llm/llm-run-worker.messages.js";
import { promptPlanFor } from "../src/prompts/prompt-plan.policy.js";

describe("LLM-run prompt plan policy", () => {
  it("returns the same deterministic five-entry v1 plan for every actor", () => {
    const expected = [
      ["competitor", "competitor_prompt_queue"],
      ["ranking", "ranking_prompt_queue"],
      ["visibility", "visibility_prompt_queue"],
      ["price_range", "price_range_prompt_queue"],
      ["pros_cons", "pros_cons_prompt_queue"]
    ];
    for (const actor of ["anonymous", "user"] as const) {
      const plan = promptPlanFor(actor);
      assert.deepEqual(
        plan.map((entry) => [entry.promptType, entry.queueName]),
        expected
      );
      assert.ok(plan.every((entry) => entry.promptVersion === "v1"));
    }
  });
});

describe("llm_run.created message validation", () => {
  it("accepts a valid message", () => {
    const message = validLlmRunEnvelope();
    assert.deepEqual(parseLlmRunCreatedMessage(message), message);
  });

  for (const required of [
    "llmRunId",
    "analysisRunItemId",
    "analysisRunId",
    "entityPathId"
  ] as const) {
    it(`rejects missing ${required}`, () => {
      const message = validLlmRunEnvelope();
      const payload = { ...message.payload };
      delete payload[required];
      assert.throws(
        () => parseLlmRunCreatedMessage({ ...message, payload }),
        InvalidLlmRunMessageError
      );
    });
  }

  it("rejects inconsistent ownership and malformed event linkage", () => {
    const message = validLlmRunEnvelope();
    assert.throws(
      () =>
        parseLlmRunCreatedMessage({
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
    assert.throws(
      () =>
        parseLlmRunCreatedMessage({
          ...message,
          eventType: "prompt_job.created"
        }),
      InvalidLlmRunMessageError
    );
    assert.throws(
      () => parseLlmRunCreatedMessage({ ...message, aggregateId: "99" }),
      /aggregateId/
    );
  });
});

export function validLlmRunEnvelope() {
  return {
    messageId: "llm_run.created:4",
    eventType: "llm_run.created",
    aggregateType: "llm_run",
    aggregateId: "4",
    occurredAt: "2026-07-25T00:00:00.000Z",
    attempt: 1,
    payload: {
      llmRunId: "4",
      analysisRunItemId: "3",
      analysisRunId: "1",
      entityPathId: "2",
      startingEntityPathId: "2",
      actorType: "anonymous" as const,
      userId: null,
      workspaceId: null,
      anonymousSessionId: "5"
    }
  };
}
