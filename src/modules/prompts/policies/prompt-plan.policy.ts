import type {
  PromptPlanEntry,
  PromptPlanPolicyContext
} from "../types/prompt.types.js";

const ANONYMOUS_PROMPT_PLAN = [
  {
    promptType: "visibility",
    promptVersion: "v1_light",
    queueName: "visibility_prompt_queue"
  },
  {
    promptType: "competitor",
    promptVersion: "v1_light",
    queueName: "competitor_prompt_queue"
  },
  {
    promptType: "ranking",
    promptVersion: "v1_light",
    queueName: "ranking_prompt_queue"
  }
] as const satisfies readonly PromptPlanEntry[];

const USER_PROMPT_PLAN = [
  {
    promptType: "visibility",
    promptVersion: "v1",
    queueName: "visibility_prompt_queue"
  },
  {
    promptType: "competitor",
    promptVersion: "v1",
    queueName: "competitor_prompt_queue"
  },
  {
    promptType: "ranking",
    promptVersion: "v1",
    queueName: "ranking_prompt_queue"
  },
  {
    promptType: "price_range",
    promptVersion: "v1",
    queueName: "price_range_prompt_queue"
  },
  {
    promptType: "pros_cons",
    promptVersion: "v1",
    queueName: "pros_cons_prompt_queue"
  }
] as const satisfies readonly PromptPlanEntry[];

export function promptPlanFor(
  context: PromptPlanPolicyContext
): readonly PromptPlanEntry[] {
  return context.actorType === "anonymous"
    ? ANONYMOUS_PROMPT_PLAN
    : USER_PROMPT_PLAN;
}
