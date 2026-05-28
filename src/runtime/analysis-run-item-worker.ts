import { Worker } from "bullmq";
import { redisConnection } from "../lib/redis.js";
import { ANALYSIS_RUN_ITEM_QUEUE_NAME } from "../queue/analysis-run-item.queue.js";
import type { AnalysisRunItemExecutionService } from "../modules/analysis/services/analysis-run-item-execution.service.js";
import type { AnalysisRunItemJobPayload } from "../types/queue.types.js";

export function createAnalysisRunItemWorker(itemExecutionService: AnalysisRunItemExecutionService) {
  const worker = new Worker<AnalysisRunItemJobPayload>(
    ANALYSIS_RUN_ITEM_QUEUE_NAME,
    async (job) => {
      await itemExecutionService.processAnalysisRunItem(job.data);
    },
    {
      connection: redisConnection,
      concurrency: 5
    }
  );

  worker.on("completed", (job) => {
    console.log(`Analysis run item job completed: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Analysis run item job failed: ${job?.id}`, error);
  });

  return worker;
}
