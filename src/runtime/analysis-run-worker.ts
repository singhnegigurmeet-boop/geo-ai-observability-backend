import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import { ANALYSIS_RUN_QUEUE_NAME } from "../queue/analysis-run.queue.js";
import type { AnalysisRunOrchestratorService } from "../modules/analysis/services/analysis-run-orchestrator.service.js";
import type { AnalysisRunJobPayload } from "../types/queue.types.js";

export function createAnalysisRunWorker(orchestratorService: AnalysisRunOrchestratorService) {
  const worker = new Worker<AnalysisRunJobPayload>(
    ANALYSIS_RUN_QUEUE_NAME,
    async (job) => {
      await orchestratorService.processAnalysisRun(job.data);
    },
    {
      connection: redisConnection,
      concurrency: 3
    }
  );

  worker.on("completed", (job) => {
    console.log(`Analysis run job completed: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Analysis run job failed: ${job?.id}`, error);
  });

  return worker;
}
