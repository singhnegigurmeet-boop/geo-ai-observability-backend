import { elasticsearch } from "./lib/elasticsearch.js";
import { AnalysisCommandService } from "./modules/analysis/services/analysis-command.service.js";
import { AnalysisJobService } from "./modules/analysis/services/analysis-job.service.js";
import { AnalysisStatusService } from "./modules/analysis/services/analysis-status.service.js";
import { DiscoveryCommandService } from "./modules/discovery/services/discovery-command.service.js";
import { ObservabilityIndexService } from "./modules/observability/services/observability-index.service.js";
import { DomainSchedulerService } from "./modules/scheduler/services/domain-scheduler.service.js";
import { NotificationService } from "./modules/notifications/services/notification.service.js";
import { notificationsRepository } from "./modules/notifications/repositories/notifications.repository.js";
import { notificationQueue } from "./queue/notification.queue.js";

export const observabilityIndexService = new ObservabilityIndexService({ elasticsearch });

export const analysisCommandService = new AnalysisCommandService();
export const analysisStatusService = new AnalysisStatusService();
export const analysisJobService = new AnalysisJobService();
export const discoveryCommandService = new DiscoveryCommandService();

export const domainSchedulerService = new DomainSchedulerService();

export const notificationService = new NotificationService({
  notificationsRepository,
  notificationQueue,
  observabilityIndexService
});

