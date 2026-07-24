import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import {
  analysisRouter,
  elasticsearch,
  pool,
  redisConnection
} from "./container.js";

const app = createApp({ analysisRouter });

const server = app.listen(env.PORT, () => {
  console.log(`GEO V6 Production Core shell listening on port ${env.PORT}`);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down API and infrastructure clients...`);

  await closeServer(server);
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
