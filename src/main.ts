import type { Server } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import {
  analysisRouter,
  pool
} from "./container.js";
import { RabbitMqConnection } from "./messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "./messaging/rabbitmq.topology.js";
import { ReadinessService } from "./observability/readiness.service.js";

const readinessRabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});
const app = createApp({
  analysisRouter,
  readinessService: new ReadinessService(pool, readinessRabbitMq)
});

const server = app.listen(env.PORT, () => {
  console.log(`GEO V6 Production Core shell listening on port ${env.PORT}`);
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down API infrastructure...`);

  await closeServer(server);
  await readinessRabbitMq.close();
  await pool.end();

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
