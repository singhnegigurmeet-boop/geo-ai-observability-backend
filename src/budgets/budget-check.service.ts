import type { ProviderName, PromptType } from "../types/database.types.js";
import { decideBudget } from "./budget-policy.service.js";
import { BudgetRepository } from "./budget.repository.js";
import type { BudgetDecision, UsageEstimate } from "./budget.types.js";
import { TokenEstimatorService } from "./token-estimator.service.js";

export type BudgetCheckResult =
  | { allowed: true; estimate: UsageEstimate }
  | {
      allowed: false;
      estimate: UsageEstimate;
      decision: Extract<BudgetDecision, { allowed: false }>;
    };

export class BudgetCheckService {
  constructor(
    private readonly budgets: BudgetRepository,
    private readonly estimator: TokenEstimatorService = new TokenEstimatorService()
  ) {}

  async checkAndReserve(input: {
    providerJobId: string;
    provider: ProviderName;
    model: string;
    workspaceId: string | null;
    promptText: string;
    promptType: PromptType;
    promptVersion: string;
  }): Promise<BudgetCheckResult> {
    const estimate = this.estimator.estimate(input);
    const policies = await this.budgets.lockApplicablePolicies({
      provider: input.provider,
      workspaceId: input.workspaceId
    });
    for (const policy of policies) {
      if (
        policy.costLimitMicros !== null &&
        policy.currencyCode !== "USD"
      ) {
        throw new Error(
          `Unsupported budget currency ${policy.currencyCode} for local USD pricing`
        );
      }
      const decision = decideBudget(
        policy,
        await this.budgets.consumption(policy),
        estimate
      );
      if (!decision.allowed) {
        return { allowed: false, estimate, decision };
      }
    }
    await this.budgets.createOrReuseEstimate({
      providerJobId: input.providerJobId,
      estimate
    });
    return { allowed: true, estimate };
  }
}
