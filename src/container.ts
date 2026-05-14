import { env } from "./config/env.js";
import { elasticsearch } from "./lib/elasticsearch.js";
import { redisConnection } from "./lib/redis.js";
import { providerAdapters } from "./providers/provider-registry.js";
import { analysisQueue } from "./queue/analysis.queue.js";
import { analysisRunsRepository } from "./repositories/analysis-runs.repository.js";
import { domainsRepository } from "./repositories/domains.repository.js";
import { providerAnalysisRepository } from "./repositories/provider-analysis.repository.js";
import { providerSnapshotsRepository } from "./repositories/provider-snapshots.repository.js";
import { visibilityScoresRepository } from "./repositories/visibility-scores.repository.js";
import { AnalysisApiService } from "./services/analysis-api.service.js";
import { AnalysisJobService } from "./services/analysis-job.service.js";
import { ObservabilityIndexService } from "./services/observability-index.service.js";
import { ProviderExecutionService } from "./services/provider-execution.service.js";
import { RateLimitService } from "./services/rate-limit.service.js";
import { VisibilityScoreService } from "./services/visibility-score.service.js";

const visibilityScoreService = new VisibilityScoreService({
  providerAnalysisRepository,
  visibilityScoresRepository
});

const providerExecutionService = new ProviderExecutionService();
const observabilityIndexService = new ObservabilityIndexService({ elasticsearch });
const rateLimitService = new RateLimitService({
  redis: redisConnection,
  uniqueDomainsPerIpLimit: env.RATE_LIMIT_UNIQUE_DOMAINS_PER_IP_PER_DAY,
  uniqueDomainsTtlSeconds: env.RATE_LIMIT_UNIQUE_DOMAINS_TTL_SECONDS,
  sameDomainPerIpLimit: env.RATE_LIMIT_SAME_DOMAIN_PER_IP_PER_HOUR,
  sameDomainTtlSeconds: env.RATE_LIMIT_SAME_DOMAIN_TTL_SECONDS
});

export const analysisApiService = new AnalysisApiService({
  analysisRunsRepository,
  domainsRepository,
  providerAnalysisRepository,
  visibilityScoresRepository,
  queue: analysisQueue,
  redis: redisConnection,
  rateLimitService,
  cacheTtlSeconds: env.CACHE_TTL_SECONDS,
  staleHours: env.ANALYSIS_STALE_HOURS
});

export const analysisJobService = new AnalysisJobService({
  analysisRunsRepository,
  providerAnalysisRepository,
  providerSnapshotsRepository,
  providerExecutionService,
  visibilityScoreService,
  observabilityIndexService,
  providerAdapters,
  redis: redisConnection,
  cacheTtlSeconds: env.CACHE_TTL_SECONDS,
  providerMaxRetries: env.PROVIDER_MAX_RETRIES
});

export { observabilityIndexService };
