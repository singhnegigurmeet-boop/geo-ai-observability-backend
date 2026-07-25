import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideBudget } from "../src/budgets/budget-policy.service.js";
import type { ApplicableBudgetPolicy } from "../src/budgets/budget.types.js";

describe("provider budget policy", () => {
  it("blocks a hard limit before projected usage crosses it", () => {
    assert.deepEqual(
      decideBudget(policy("hard", "100"), {
        totalTokens: "80",
        costMicros: "0"
      }, estimate(21)),
      {
        allowed: false,
        budgetPolicyId: "1",
        budgetScope: "platform_default",
        limitMode: "hard",
        reason: "token_limit"
      }
    );
    assert.deepEqual(
      decideBudget(policy("hard", "100"), {
        totalTokens: "80",
        costMicros: "0"
      }, estimate(20)),
      { allowed: true }
    );
  });

  it("allows one soft crossing prompt and blocks after consumption exceeds the limit", () => {
    const soft = policy("soft", "100");
    assert.deepEqual(
      decideBudget(
        soft,
        { totalTokens: "100", costMicros: "0" },
        estimate(25)
      ),
      { allowed: true }
    );
    assert.equal(
      decideBudget(
        soft,
        { totalTokens: "125", costMicros: "0" },
        estimate(1)
      ).allowed,
      false
    );
  });

  it("enforces integer cost limits independently of token limits", () => {
    const costPolicy = {
      ...policy("hard", null),
      costLimitMicros: "5"
    };
    assert.equal(
      decideBudget(
        costPolicy,
        { totalTokens: "0", costMicros: "4" },
        { ...estimate(1), costMicros: 2 }
      ).allowed,
      false
    );
  });
});

function policy(
  limitMode: "hard" | "soft",
  tokenLimit: string | null
): ApplicableBudgetPolicy {
  return {
    budgetPolicyId: "1",
    budgetScope: "platform_default",
    workspaceId: null,
    provider: "mock",
    limitMode,
    windowSeconds: 3600,
    tokenLimit,
    costLimitMicros: null,
    currencyCode: "USD"
  };
}

function estimate(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    costMicros: 0
  };
}
