import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetCheckService } from "../src/budgets/budget-check.service.js";
import type { BudgetRepository } from "../src/budgets/budget.repository.js";

describe("budget check and estimated-usage reservation", () => {
  it("locks and applies platform plus workspace policies before reserving", async () => {
    const calls: string[] = [];
    const repository = {
      async lockApplicablePolicies() {
        calls.push("lock");
        return [
          policy("1", "platform_default", null),
          policy("2", "workspace", "7")
        ];
      },
      async consumption() {
        calls.push("consume");
        return { totalTokens: "0", costMicros: "0" };
      },
      async createOrReuseEstimate() {
        calls.push("reserve");
        return {};
      }
    } as unknown as BudgetRepository;
    const result = await new BudgetCheckService(repository).checkAndReserve({
      providerJobId: "9",
      provider: "mock",
      model: "mock-standard",
      workspaceId: "7",
      promptText: "Budget-safe canonical prompt",
      promptType: "visibility",
      promptVersion: "v1"
    });

    assert.equal(result.allowed, true);
    assert.deepEqual(calls, ["lock", "consume", "consume", "reserve"]);
  });

  it("does not reserve estimated usage when a policy blocks", async () => {
    let reserved = false;
    const repository = {
      async lockApplicablePolicies() {
        return [policy("1", "platform_default", null, "1")];
      },
      async consumption() {
        return { totalTokens: "1", costMicros: "0" };
      },
      async createOrReuseEstimate() {
        reserved = true;
        return {};
      }
    } as unknown as BudgetRepository;
    const result = await new BudgetCheckService(repository).checkAndReserve({
      providerJobId: "9",
      provider: "mock",
      model: "mock-fast",
      workspaceId: null,
      promptText: "Canonical prompt",
      promptType: "ranking",
      promptVersion: "v1_light"
    });

    assert.equal(result.allowed, false);
    assert.equal(reserved, false);
  });

  it("rejects a cost policy whose currency cannot be reconciled", async () => {
    const repository = {
      async lockApplicablePolicies() {
        return [
          {
            ...policy("1", "platform_default", null),
            costLimitMicros: "100",
            currencyCode: "EUR"
          }
        ];
      },
      async consumption() {
        throw new Error("must not read incomparable consumption");
      },
      async createOrReuseEstimate() {
        throw new Error("must not reserve");
      }
    } as unknown as BudgetRepository;
    await assert.rejects(
      new BudgetCheckService(repository).checkAndReserve({
        providerJobId: "9",
        provider: "mock",
        model: "mock-fast",
        workspaceId: null,
        promptText: "Canonical prompt",
        promptType: "ranking",
        promptVersion: "v1_light"
      }),
      /Unsupported budget currency EUR/
    );
  });
});

function policy(
  budgetPolicyId: string,
  budgetScope: "platform_default" | "workspace",
  workspaceId: string | null,
  tokenLimit = "100000"
) {
  return {
    budgetPolicyId,
    budgetScope,
    workspaceId,
    provider: "mock" as const,
    limitMode: "hard" as const,
    windowSeconds: 3600,
    tokenLimit,
    costLimitMicros: null,
    currencyCode: "USD"
  };
}
