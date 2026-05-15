import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import { ANALYSIS_QUEUE_NAME } from "../queue/analysis.queue.js";
import { AnalysisJobService } from "../modules/analysis/services/analysis-job.service.js";
import type { AnalysisJobData } from "../types/queue.types.js";

export function createAnalysisWorker(jobService: AnalysisJobService) {
  const worker = new Worker<AnalysisJobData>(
    ANALYSIS_QUEUE_NAME,
    async (job) => {
      await jobService.processAnalysisJob(job.data);
    },
    {
      connection: redisConnection,
      concurrency: 3
    }
  );

  worker.on("completed", (job) => {
    console.log(`Analysis job completed: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Analysis job failed: ${job?.id}`, error);
  });

  return worker;
}
