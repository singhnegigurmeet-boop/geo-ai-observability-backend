export const QUEUE_NAMES = [
  "analysis_run_queue",
  "analysis_run_item_queue",
  "llm_run_queue",
  "competitor_prompt_queue",
  "ranking_prompt_queue",
  "visibility_prompt_queue",
  "price_range_prompt_queue",
  "pros_cons_prompt_queue",
  "openai_queue",
  "gemini_queue",
  "claude_queue",
  "scheduler_queue",
  "notification_queue"
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

const queueNameSet = new Set<string>(QUEUE_NAMES);

export function isQueueName(value: unknown): value is QueueName {
  return typeof value === "string" && queueNameSet.has(value);
}

export function deadLetterQueueName(queueName: QueueName) {
  return `${queueName}.dlq` as const;
}
