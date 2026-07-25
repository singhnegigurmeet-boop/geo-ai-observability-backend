import { createAnalysisModule } from "./analysis/analysis.module.js";
import { env } from "./config/env.js";
export { elasticsearch } from "./lib/elasticsearch.js";
import { pool } from "./lib/postgres.js";
export { redisConnection } from "./lib/redis.js";

export { pool };

export const analysisRouter = createAnalysisModule(pool, {
  sessionTokenPepper: env.SESSION_TOKEN_PEPPER,
  userSessionTtlSeconds: env.USER_SESSION_TTL_SECONDS,
  anonymousSessionTtlSeconds: env.ANONYMOUS_SESSION_TTL_SECONDS,
  realProvidersEnabled: env.ENABLE_REAL_PROVIDERS
});
