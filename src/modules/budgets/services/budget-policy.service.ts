import type {
  ApplicableBudgetPolicy,
  BudgetConsumption,
  BudgetDecision,
  UsageEstimate
} from "../types/budget.types.js";

export function decideBudget(
  policy: ApplicableBudgetPolicy,
  consumed: BudgetConsumption,
  estimate: UsageEstimate
): BudgetDecision {
  const currentTokens = BigInt(consumed.totalTokens);
  const currentCost = BigInt(consumed.costMicros);
  const projectedTokens = currentTokens + BigInt(estimate.totalTokens);
  const projectedCost = currentCost + BigInt(estimate.costMicros);

  const tokenExceeded =
    policy.tokenLimit !== null &&
    (policy.limitMode === "hard"
      ? projectedTokens > BigInt(policy.tokenLimit)
      : currentTokens > BigInt(policy.tokenLimit));
  if (tokenExceeded) {
    return blocked(policy, "token_limit");
  }

  const costExceeded =
    policy.costLimitMicros !== null &&
    (policy.limitMode === "hard"
      ? projectedCost > BigInt(policy.costLimitMicros)
      : currentCost > BigInt(policy.costLimitMicros));
  if (costExceeded) {
    return blocked(policy, "cost_limit");
  }
  return { allowed: true };
}

function blocked(
  policy: ApplicableBudgetPolicy,
  reason: "token_limit" | "cost_limit"
): BudgetDecision {
  return {
    allowed: false,
    budgetPolicyId: policy.budgetPolicyId,
    budgetScope: policy.budgetScope,
    limitMode: policy.limitMode,
    reason
  };
}
