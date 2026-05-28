import { Queue } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import type { AnalysisRunJobPayload } from "../types/queue.types.js";

export const ANALYSIS_RUN_QUEUE_NAME = "analysis_run_queue";

export const analysisRunQueue = new Queue<AnalysisRunJobPayload>(ANALYSIS_RUN_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000
    },
    removeOnComplete: {
      age: 3600
    },
    removeOnFail: {
      age: 86400
    }
  }
});
