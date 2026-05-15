import { env } from "./config/env.js";
import { elasticsearch } from "./lib/elasticsearch.js";
import { redisConnection } from "./lib/redis.js";
import { providerAdapters } from "./modules/providers/adapters/provider-registry.js";
import { analysisQueue } from "./queue/analysis.queue.js";
import { notificationQueue } from "./queue/notification.queue.js";
import { analysisDiffsRepository } from "./modules/diffs/repositories/analysis-diffs.repository.js";
import { analysisRunsRepository } from "./modules/analysis/repositories/analysis-runs.repository.js";
import { domainSchedulesRepository } from "./modules/scheduler/repositories/domain-schedules.repository.js";
import { domainsRepository } from "./repositories/domains.repository.js";
import { notificationsRepository } from "./modules/notifications/repositories/notifications.repository.js";
import { providerAnalysisRepository } from "./modules/providers/repositories/provider-analysis.repository.js";
import { providerSnapshotsRepository } from "./modules/providers/repositories/provider-snapshots.repository.js";
import { visibilityScoresRepository } from "./modules/visibility/repositories/visibility-scores.repository.js";
import { AnalysisCommandService } from "./modules/analysis/services/analysis-command.service.js";
import { AnalysisJobService } from "./modules/analysis/services/analysis-job.service.js";
import { AnalysisStatusService } from "./modules/analysis/services/analysis-status.service.js";
import { DiffEngineService } from "./modules/diffs/services/diff-engine.service.js";
import { ObservabilityIndexService } from "./modules/observability/services/observability-index.service.js";
import { DomainSchedulerService } from "./modules/scheduler/services/domain-scheduler.service.js";
import { NotificationService } from "./modules/notifications/services/notification.service.js";
import { ProviderExecutionService } from "./modules/providers/services/provider-execution.service.js";
import { ProviderScoresService } from "./modules/providers/services/provider-scores.service.js";
import { RateLimitService } from "./services/rate-limit.service.js";
import { ScheduleManagementService } from "./modules/scheduler/services/schedule-management.service.js";
import { VisibilityScoreReadService } from "./modules/visibility/services/visibility-score-read.service.js";
import { VisibilityScoreService } from "./modules/visibility/services/visibility-score.service.js";

const visibilityScoreService = new VisibilityScoreService({
  providerAnalysisRepository,
  visibilityScoresRepository
});

const providerExecutionService = new ProviderExecutionService();
const observabilityIndexService = new ObservabilityIndexService({ elasticsearch });
export const notificationService = new NotificationService({
  notificationsRepository,
  notificationQueue,
  observabilityIndexService
});
export const domainSchedulerService = new DomainSchedulerService({
  analysisRunsRepository,
  domainSchedulesRepository,
  analysisQueue,
  observabilityIndexService
});
export const scheduleManagementService = new ScheduleManagementService({
  domainsRepository,
  domainSchedulesRepository
});
const diffEngineService = new DiffEngineService({
  analysisDiffsRepository,
  analysisRunsRepository,
  providerSnapshotsRepository,
  visibilityScoresRepository
});
const rateLimitService = new RateLimitService({
  redis: redisConnection,
  uniqueDomainsPerIpLimit: env.RATE_LIMIT_UNIQUE_DOMAINS_PER_IP_PER_DAY,
  uniqueDomainsTtlSeconds: env.RATE_LIMIT_UNIQUE_DOMAINS_TTL_SECONDS,
  sameDomainPerIpLimit: env.RATE_LIMIT_SAME_DOMAIN_PER_IP_PER_HOUR,
  sameDomainTtlSeconds: env.RATE_LIMIT_SAME_DOMAIN_TTL_SECONDS
});

export const analysisCommandService = new AnalysisCommandService({
  analysisRunsRepository,
  domainsRepository,
  visibilityScoresRepository,
  queue: analysisQueue,
  redis: redisConnection,
  rateLimitService,
  cacheTtlSeconds: env.CACHE_TTL_SECONDS,
  staleHours: env.ANALYSIS_STALE_HOURS
});

export const analysisStatusService = new AnalysisStatusService({
  analysisRunsRepository,
  domainsRepository,
  analysisDiffsRepository,
  providerAnalysisRepository,
  visibilityScoresRepository
});

export const providerScoresService = new ProviderScoresService({
  domainsRepository,
  providerAnalysisRepository,
  providerSnapshotsRepository
});

export const visibilityScoreReadService = new VisibilityScoreReadService({
  domainsRepository,
  visibilityScoresRepository
});

export const analysisJobService = new AnalysisJobService({
  analysisRunsRepository,
  providerAnalysisRepository,
  providerSnapshotsRepository,
  providerExecutionService,
  visibilityScoreService,
  diffEngineService,
  notificationService,
  observabilityIndexService,
  providerAdapters,
  redis: redisConnection,
  cacheTtlSeconds: env.CACHE_TTL_SECONDS,
  providerMaxRetries: env.PROVIDER_MAX_RETRIES
});

export { observabilityIndexService };
