import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import {
  analysisCommandService,
  analysisJobService,
  analysisStatusService,
  domainSchedulerService,
  notificationService,
  observabilityIndexService,
  providerScoresService,
  scheduleManagementService,
  visibilityScoreReadService
} from "./container.js";
import { elasticsearch } from "./lib/elasticsearch.js";
import { pool } from "./lib/postgres.js";
import { redisConnection } from "./lib/redis.js";
import { analysisQueue } from "./queue/analysis.queue.js";
import { notificationQueue } from "./queue/notification.queue.js";
import { ensureDomainSchedulerRepeatableJob, schedulerQueue } from "./queue/scheduler.queue.js";
import { createAnalysisWorker } from "./runtime/analysis-worker.js";
import { createNotificationWorker } from "./runtime/notification-worker.js";
import { createSchedulerWorker } from "./runtime/scheduler-worker.js";

const app = createApp({
  analysisCommandService,
  analysisStatusService,
  providerScoresService,
  scheduleManagementService,
  visibilityScoreReadService
});

await observabilityIndexService.initialize();

const worker = createAnalysisWorker(analysisJobService);
const schedulerWorker = createSchedulerWorker(domainSchedulerService);
const notificationWorker = createNotificationWorker(notificationService);

await ensureDomainSchedulerRepeatableJob();

const server = app.listen(env.PORT, () => {
  console.log(`GEO observability API listening on port ${env.PORT}`);
  console.log("Analysis, scheduler, and notification workers started in the same process.");
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down API and workers...`);

  await closeServer(server);
  await worker.close();
  await schedulerWorker.close();
  await notificationWorker.close();
  await analysisQueue.close();
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
