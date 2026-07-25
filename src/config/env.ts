import "dotenv/config";
import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    ELASTICSEARCH_NODE: z.string().url(),
    RABBITMQ_URL: z.string().url(),
    RABBITMQ_EXCHANGE: z.string().min(1).default("geo.v6.main"),
    RABBITMQ_DEAD_LETTER_EXCHANGE: z.string().min(1).default("geo.v6.dlx"),
    RABBITMQ_CONFIRM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    ANALYSIS_RUN_WORKER_PREFETCH: z.coerce.number().int().min(1).max(100).default(5),
    ANALYSIS_RUN_ITEM_WORKER_PREFETCH: z.coerce.number().int().min(1).max(100).default(10),
    LLM_RUN_WORKER_PREFETCH: z.coerce.number().int().min(1).max(100).default(10),
    SESSION_TOKEN_PEPPER: z.string().min(32),
    USER_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    ANONYMOUS_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1_000),
    OUTBOX_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
    OUTBOX_RETRY_BASE_MS: z.coerce.number().int().min(100).default(1_000),
    OUTBOX_RETRY_MAX_MS: z.coerce.number().int().min(100).default(60_000)
  })
  .refine(
    (value) => value.OUTBOX_RETRY_MAX_MS >= value.OUTBOX_RETRY_BASE_MS,
    {
      message: "OUTBOX_RETRY_MAX_MS must be greater than or equal to OUTBOX_RETRY_BASE_MS",
      path: ["OUTBOX_RETRY_MAX_MS"]
    }
  );

export const env = envSchema.parse(process.env);
