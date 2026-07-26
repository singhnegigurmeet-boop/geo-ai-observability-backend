import type {
  EntityPathType,
  PromptDepth,
  PromptType
} from "../../../common/types/database.types.js";

export const PROMPT_POLICY_VERSION = "geo-prompt-policy-v1";

export const PROMPT_TYPE_POLICY = {
  visibility: {
    businessPromptVersion: "visibility-v1",
    responseContractVersion: "visibility-response-v1",
    requiresScoring: true
  },
  ranking: {
    businessPromptVersion: "ranking-v1",
    responseContractVersion: "ranking-response-v1",
    requiresScoring: true
  },
  competitor: {
    businessPromptVersion: "competitor-v1",
    responseContractVersion: "competitor-response-v1",
    requiresScoring: false
  },
  price_range: {
    businessPromptVersion: "price-range-v1",
    responseContractVersion: "price-range-response-v1",
    requiresScoring: false
  },
  pros_cons: {
    businessPromptVersion: "pros-cons-v1",
    responseContractVersion: "pros-cons-response-v1",
    requiresScoring: false
  }
} as const satisfies Record<
  PromptType,
  {
    businessPromptVersion: string;
    responseContractVersion: string;
    requiresScoring: boolean;
  }
>;

export const PROMPT_DEPTH_LIMITS = {
  weak: {
    topK: 5,
    maxEvidenceItems: 3,
    maxListItems: 3,
    maxSummaryCharacters: 500,
    outputTokenFactor: 0.6
  },
  medium: {
    topK: 10,
    maxEvidenceItems: 6,
    maxListItems: 6,
    maxSummaryCharacters: 1_000,
    outputTokenFactor: 1
  },
  high: {
    topK: 20,
    maxEvidenceItems: 10,
    maxListItems: 10,
    maxSummaryCharacters: 2_000,
    outputTokenFactor: 1.6
  }
} as const satisfies Record<
  PromptDepth,
  {
    topK: number;
    maxEvidenceItems: number;
    maxListItems: number;
    maxSummaryCharacters: number;
    outputTokenFactor: number;
  }
>;

const CATEGORY_PROMPTS = [
  "visibility",
  "ranking",
  "competitor"
] as const satisfies readonly PromptType[];

const DEEP_PROMPTS = [
  ...CATEGORY_PROMPTS,
  "price_range",
  "pros_cons"
] as const satisfies readonly PromptType[];

export function applicablePromptTypes(
  targetLevel: EntityPathType
): readonly PromptType[] {
  if (targetLevel === "domain") return [];
  return targetLevel === "category" ? CATEGORY_PROMPTS : DEEP_PROMPTS;
}

export function promptTypePolicy(promptType: PromptType) {
  return PROMPT_TYPE_POLICY[promptType];
}

export function requiresScoring(promptType: PromptType) {
  return PROMPT_TYPE_POLICY[promptType].requiresScoring;
}

export function resolvePromptDepth(
  actorType: "anonymous" | "user",
  requestedDepth: PromptDepth | undefined
): PromptDepth {
  if (actorType === "anonymous") {
    if (requestedDepth !== undefined && requestedDepth !== "weak") {
      throw new InvalidPromptDepthError(
        "Anonymous analysis is restricted to weak prompt depth"
      );
    }
    return "weak";
  }
  if (!requestedDepth) {
    throw new InvalidPromptDepthError(
      "promptDepth is required for logged-in and claimed analysis"
    );
  }
  return requestedDepth;
}

export class InvalidPromptDepthError extends Error {
  readonly code = "INVALID_PROMPT_DEPTH";
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "InvalidPromptDepthError";
  }
}

