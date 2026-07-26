import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidLlmRunMessageError,
  parseLlmRunCreatedMessage
} from "../../../src/modules/llm/messages/llm-run-worker.messages.js";
import { promptPlanFor } from "../../../src/modules/prompts/policies/prompt-plan.policy.js";

describe("LLM-run prompt plan policy", () => {
  it("returns no normal prompts for a domain-only target", () => {
    const plan = promptPlanFor({
      pathLevel: "domain",
      promptDepth: "weak"
    });
    assert.deepEqual(plan, []);
  });

  it("returns the three category-level prompts at the frozen depth", () => {
    const plan = promptPlanFor({
      pathLevel: "category",
      promptDepth: "weak"
    });
    assert.deepEqual(
      plan.map((entry) => [
        entry.promptType,
        entry.promptDepth,
        entry.queueName
      ]),
      [
        ["visibility", "weak", "visibility_prompt_queue"],
        ["ranking", "weak", "ranking_prompt_queue"],
        ["competitor", "weak", "competitor_prompt_queue"]
      ]
    );
  });

  it("returns all five prompts for deeper target paths", () => {
    const expected = [
      ["visibility", "visibility_prompt_queue"],
      ["ranking", "ranking_prompt_queue"],
      ["competitor", "competitor_prompt_queue"],
      ["price_range", "price_range_prompt_queue"],
      ["pros_cons", "pros_cons_prompt_queue"]
    ];
    for (const pathLevel of ["brand", "product", "use_context"] as const) {
      const plan = promptPlanFor({ pathLevel, promptDepth: "high" });
      assert.deepEqual(
        plan.map((entry) => [entry.promptType, entry.queueName]),
        expected
      );
      assert.ok(plan.every((entry) => entry.promptDepth === "high"));
    }
  });
});

describe("llm_run.created message validation", () => {
  it("accepts a valid message", () => {
    const message = validLlmRunEnvelope();
    assert.deepEqual(parseLlmRunCreatedMessage(message), message);
  });

  for (const required of ["llmRunId"] as const) {
    it(`rejects missing ${required}`, () => {
      const message = validLlmRunEnvelope();
      const payload: Partial<typeof message.payload> = { ...message.payload };
      delete payload[required];
      assert.throws(
        () => parseLlmRunCreatedMessage({ ...message, payload }),
        InvalidLlmRunMessageError
      );
    });
  }

  it("rejects duplicated business state and malformed event linkage", () => {
    const message = validLlmRunEnvelope();
    assert.throws(
      () =>
        parseLlmRunCreatedMessage({
          ...message,
          payload: {
            ...message.payload,
            actorType: "user"
          }
        }),
      InvalidLlmRunMessageError
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
    payload: { llmRunId: "4" }
  };
}
