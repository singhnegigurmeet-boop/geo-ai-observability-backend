import { AnalysisRunItemWorker } from "../workers/analysis-run-item-worker.js";
import { env } from "../../../common/config/env.js";
import { pool } from "../../../common/database/postgres.js";
import { LlmRunCreationService } from "../../llm/services/llm-run-creation.service.js";
import { RabbitMqConnection } from "../../../common/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../../common/messaging/rabbitmq.topology.js";
import { FailureRecordRepository } from "../../reliability/repositories/failure-record.repository.js";
import { AnalysisRunItemWorkerRuntime } from "../runtime/analysis-run-item-worker.runtime.js";

const rabbitMq = new RabbitMqConnection({
  url: env.RABBITMQ_URL,
  initializeChannel: (channel) =>
    declareRabbitMqTopology(channel, {
      mainExchange: env.RABBITMQ_EXCHANGE,
      deadLetterExchange: env.RABBITMQ_DEAD_LETTER_EXCHANGE
    })
});

let shuttingDown = false;
let runtime: AnalysisRunItemWorkerRuntime | null = null;

async function main() {
  const channel = await rabbitMq.getConfirmChannel();
  runtime = new AnalysisRunItemWorkerRuntime(
    channel,
    new AnalysisRunItemWorker(new LlmRunCreationService(pool)),
    new FailureRecordRepository(pool),
    {
      mainExchange: env.RABBITMQ_EXCHANGE,
      prefetch: env.ANALYSIS_RUN_ITEM_WORKER_PREFETCH
    }
  );
  await runtime.start();
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Stopping analysis run item worker...`);
  await runtime?.stop();
  await rabbitMq.close();
  await pool.end();
}

main().catch(async (error) => {
  console.error("Analysis run item worker failed.", error);
  process.exitCode = 1;
  await rabbitMq.close();
  await pool.end();
});
