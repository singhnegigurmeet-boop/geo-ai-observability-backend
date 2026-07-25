import { env } from "../config/env.js";
import { pool } from "../lib/postgres.js";
import { SchedulerService } from "../scheduler/scheduler.service.js";

const scheduler = new SchedulerService(pool, env.ENABLE_REAL_PROVIDERS);
let stopping = false;
let timer: NodeJS.Timeout | null = null;

async function poll() {
  if (stopping) return;
  try {
    const results = await scheduler.drainDue({
      limit: env.SCHEDULER_BATCH_SIZE
    });
    if (results.length > 0) {
      console.info("Scheduler poll completed.", {
        processed: results.length,
        enqueued: results.filter((result) => result.outcome === "enqueued").length,
        failed: results.filter((result) => result.outcome === "failed").length
      });
    }
  } catch (error) {
    console.error("Scheduler poll failed.", error);
  } finally {
    if (!stopping) {
      timer = setTimeout(poll, env.SCHEDULER_POLL_INTERVAL_MS);
    }
  }
}

async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  console.info(`Received ${signal}. Stopping scheduler worker.`);
  await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void poll();
