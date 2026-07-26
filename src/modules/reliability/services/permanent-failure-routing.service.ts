import {
  PROMPT_QUEUE_NAMES,
  type QueueName
} from "../../../common/messaging/queue-names.js";

const PROVIDER_QUEUE_NAMES = [
  "openai_queue",
  "gemini_queue",
  "claude_queue",
  "mock_queue"
] as const satisfies readonly QueueName[];

export type PermanentFailureRoute =
  | "analysis_run"
  | "analysis_run_item"
  | "llm_run"
  | "prompt_job"
  | "provider_job"
  | "normal_scoring"
  | "classification_job"
  | "classification_result"
  | "scheduler_job"
  | "notification";

export class UnsupportedPermanentFailureRouteError extends Error {
  readonly code = "UNSUPPORTED_PERMANENT_FAILURE_ROUTE";

  constructor(aggregateType: string, queueName: string) {
    super(
      `Unsupported permanent-failure route: ${aggregateType} on ${queueName}`
    );
    this.name = "UnsupportedPermanentFailureRouteError";
  }
}

export function resolvePermanentFailureRoute(
  aggregateType: string,
  queueName: string
): PermanentFailureRoute {
  if (aggregateType === "analysis_run" && queueName === "analysis_run_queue") {
    return "analysis_run";
  }
  if (
    aggregateType === "analysis_run_item" &&
    queueName === "analysis_run_item_queue"
  ) {
    return "analysis_run_item";
  }
  if (aggregateType === "llm_run" && queueName === "llm_run_queue") {
    return "llm_run";
  }
  if (
    aggregateType === "prompt_job" &&
    (PROMPT_QUEUE_NAMES as readonly string[]).includes(queueName)
  ) {
    return "prompt_job";
  }
  if (
    aggregateType === "provider_job" &&
    (PROVIDER_QUEUE_NAMES as readonly string[]).includes(queueName)
  ) {
    return "provider_job";
  }
  if (aggregateType === "provider_result" && queueName === "scoring_queue") {
    return "normal_scoring";
  }
  if (
    aggregateType === "domain_category_classification" &&
    queueName === "domain_category_classification_queue"
  ) {
    return "classification_job";
  }
  if (
    aggregateType === "provider_result" &&
    queueName === "domain_category_classification_result_queue"
  ) {
    return "classification_result";
  }
  if (aggregateType === "scheduler_job" && queueName === "scheduler_queue") {
    return "scheduler_job";
  }
  if (aggregateType === "notification" && queueName === "notification_queue") {
    return "notification";
  }
  throw new UnsupportedPermanentFailureRouteError(aggregateType, queueName);
}
