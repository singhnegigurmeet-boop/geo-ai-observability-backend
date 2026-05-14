import "dotenv/config";
import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }

  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ELASTICSEARCH_NODE: z.string().url(),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  ANALYSIS_STALE_HOURS: z.coerce.number().int().positive().default(24),
  RATE_LIMIT_UNIQUE_DOMAINS_PER_IP_PER_DAY: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_UNIQUE_DOMAINS_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  RATE_LIMIT_SAME_DOMAIN_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_SAME_DOMAIN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  PROVIDER_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  USE_MOCK_PROVIDERS: booleanFromEnv.default(true),
  ALLOW_MISSING_PROVIDER_KEYS: booleanFromEnv.default(false),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4.1-mini"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-3-5-haiku-latest")
});

const parsedEnv = envSchema.parse(process.env);

if (!parsedEnv.USE_MOCK_PROVIDERS && !parsedEnv.ALLOW_MISSING_PROVIDER_KEYS) {
  const missingKeys = [
    ["OPENAI_API_KEY", parsedEnv.OPENAI_API_KEY],
    ["GEMINI_API_KEY", parsedEnv.GEMINI_API_KEY],
    ["ANTHROPIC_API_KEY", parsedEnv.ANTHROPIC_API_KEY]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingKeys.length > 0) {
    throw new Error(`Missing provider API keys: ${missingKeys.join(", ")}`);
  }
}

export const env = parsedEnv;
