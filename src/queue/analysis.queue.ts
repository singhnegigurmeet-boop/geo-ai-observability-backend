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
    // Keep up to 1000 completed jobs or 1 day (whichever comes first)
    removeOnComplete: { count: 1000, age: 86400 },
    // Keep up to 500 failed jobs or 7 days (whichever comes first)
    removeOnFail: { count: 500, age: 604800 }
  }
});
