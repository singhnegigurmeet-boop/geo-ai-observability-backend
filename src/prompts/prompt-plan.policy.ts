import type { PromptPlanEntry } from "./prompt.types.js";

const CORE_PROMPT_PLAN = [
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
    promptType: "visibility",
    promptVersion: "v1",
    queueName: "visibility_prompt_queue"
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
  _actorType: "anonymous" | "user"
): readonly PromptPlanEntry[] {
  return CORE_PROMPT_PLAN;
}
