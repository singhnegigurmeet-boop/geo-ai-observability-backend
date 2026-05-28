import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import {
  analysisCommandService,
  analysisRunItemExecutionService,
  analysisRunOrchestratorService,
  analysisStatusService,
  discoveryCommandService,
  domainSchedulerService,
  notificationService,
  observabilityIndexService
} from "./container.js";
import { elasticsearch } from "./lib/elasticsearch.js";
import { pool } from "./lib/postgres.js";
import { redisConnection } from "./lib/redis.js";
import { analysisRunItemQueue } from "./queue/analysis-run-item.queue.js";
import { analysisRunQueue } from "./queue/analysis-run.queue.js";
import { notificationQueue } from "./queue/notification.queue.js";
import { ensureV6SchedulerRepeatableJob, schedulerQueue } from "./queue/scheduler.queue.js";
import { createAnalysisRunItemWorker } from "./runtime/analysis-run-item-worker.js";
import { createAnalysisRunWorker } from "./runtime/analysis-run-worker.js";
import { createNotificationWorker } from "./runtime/notification-worker.js";
import { createSchedulerWorker } from "./runtime/scheduler-worker.js";

const app = createApp({
  analysisCommandService,
  analysisStatusService,
  discoveryCommandService
});

await observabilityIndexService.initialize();

const analysisRunWorker = createAnalysisRunWorker(analysisRunOrchestratorService);
const analysisRunItemWorker = createAnalysisRunItemWorker(analysisRunItemExecutionService);
const schedulerWorker = createSchedulerWorker(domainSchedulerService);
const notificationWorker = createNotificationWorker(notificationService);

await ensureV6SchedulerRepeatableJob();

const server = app.listen(env.PORT, () => {
  console.log(`GEO observability API listening on port ${env.PORT}`);
  console.log("V6 placeholder analysis, scheduler, and notification workers started in the same process.");
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down API and workers...`);

  await closeServer(server);
  await analysisRunWorker.close();
  await analysisRunItemWorker.close();
  await schedulerWorker.close();
  await notificationWorker.close();
  await analysisRunQueue.close();
  await analysisRunItemQueue.close();
  await schedulerQueue.close();
  await notificationQueue.close();
  await redisConnection.quit();
  await pool.end();
  await elasticsearch.close();

  console.log("Shutdown complete.");
}

function closeServer(serverToClose: Server) {
  return new Promise<void>((resolve, reject) => {
    serverToClose.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

process.on("SIGINT", () => {
  shutdown("SIGINT")
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM")
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
});

server.on("close", () => {
  if (!shuttingDown) {
    shutdown("server close").catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
});
