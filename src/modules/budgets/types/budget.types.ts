import type {
  BudgetLimitMode,
  BudgetScope,
  ProviderName
} from "../../../common/types/database.types.js";

export type UsageEstimate = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
};

export type ApplicableBudgetPolicy = {
  budgetPolicyId: string;
  budgetScope: BudgetScope;
  workspaceId: string | null;
  userId: string | null;
  anonymousSessionId: string | null;
  analysisRunId: string | null;
  provider: ProviderName;
  model: string | null;
  limitMode: BudgetLimitMode;
  windowSeconds: number;
  tokenLimit: string | null;
  costLimitMicros: string | null;
  currencyCode: string;
};

export type BudgetConsumption = {
  totalTokens: string;
  costMicros: string;
};

export type BudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      budgetPolicyId: string;
      budgetScope: BudgetScope;
      limitMode: BudgetLimitMode;
      reason: "token_limit" | "cost_limit";
    };
