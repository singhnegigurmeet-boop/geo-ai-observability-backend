import { Queue } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import type { AnalysisJobData } from "../types/queue.types.js";

export const ANALYSIS_QUEUE_NAME = "domain-analysis";

export const analysisQueue = new Queue<AnalysisJobData>(ANALYSIS_QUEUE_NAME, {
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
