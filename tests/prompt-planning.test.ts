import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidLlmRunMessageError,
  parseLlmRunCreatedMessage
} from "../src/llm/llm-run-worker.messages.js";
import { promptPlanFor } from "../src/prompts/prompt-plan.policy.js";

describe("LLM-run prompt plan policy", () => {
  it("returns a reduced light plan for anonymous work", () => {
    const plan = promptPlanFor(policyContext("anonymous"));
    assert.deepEqual(
      plan.map((entry) => [
        entry.promptType,
        entry.promptVersion,
        entry.queueName
      ]),
      [
        ["visibility", "v1_light", "visibility_prompt_queue"],
        ["competitor", "v1_light", "competitor_prompt_queue"],
        ["ranking", "v1_light", "ranking_prompt_queue"]
      ]
    );
  });

  it("returns the richer five-job plan for users and claimed sessions", () => {
    const expected = [
      ["visibility", "visibility_prompt_queue"],
      ["competitor", "competitor_prompt_queue"],
      ["ranking", "ranking_prompt_queue"],
      ["price_range", "price_range_prompt_queue"],
      ["pros_cons", "pros_cons_prompt_queue"]
    ];
    for (const anonymousSessionId of [null, "9"]) {
      const plan = promptPlanFor({
        ...policyContext("user"),
        anonymousSessionId
      });
      assert.deepEqual(
        plan.map((entry) => [entry.promptType, entry.queueName]),
        expected
      );
      assert.ok(plan.every((entry) => entry.promptVersion === "v1"));
    }
  });
});

function policyContext(actorType: "anonymous" | "user") {
  return {
    actorType,
    userId: actorType === "user" ? "1" : null,
    workspaceId: actorType === "user" ? "2" : null,
    anonymousSessionId: actorType === "anonymous" ? "3" : null,
    pathLevel: "domain" as const,
    requestedProvider: actorType === "user" ? ("mock" as const) : null,
    requestedModel: actorType === "user" ? "mock-standard" : null
  };
}

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
