import { elasticsearch } from "./lib/elasticsearch.js";
import { AnalysisCommandService } from "./modules/analysis/services/analysis-command.service.js";
import { analysisRunItemsRepository } from "./modules/analysis/repositories/analysis-run-items.repository.js";
import { analysisRunsRepository } from "./modules/analysis/repositories/analysis-runs.repository.js";
import { AnalysisRequestValidationService } from "./modules/analysis/services/analysis-request-validation.service.js";
import { AnalysisRunItemExecutionService } from "./modules/analysis/services/analysis-run-item-execution.service.js";
import { AnalysisRunOrchestratorService } from "./modules/analysis/services/analysis-run-orchestrator.service.js";
import { AnalysisRunStatusAggregatorService } from "./modules/analysis/services/analysis-run-status-aggregator.service.js";
import { AnalysisStatusService } from "./modules/analysis/services/analysis-status.service.js";
import { DiscoveryCommandService } from "./modules/discovery/services/discovery-command.service.js";
import { discoveryRequestsRepository } from "./modules/discovery/repositories/discovery-requests.repository.js";
import { ObservabilityIndexService } from "./modules/observability/services/observability-index.service.js";
import { DomainSchedulerService } from "./modules/scheduler/services/domain-scheduler.service.js";
import { NotificationService } from "./modules/notifications/services/notification.service.js";
import { notificationsRepository } from "./modules/notifications/repositories/notifications.repository.js";
import { analysisRunItemQueue } from "./queue/analysis-run-item.queue.js";
import { analysisRunQueue } from "./queue/analysis-run.queue.js";
import { notificationQueue } from "./queue/notification.queue.js";
import { domainsRepository } from "./repositories/domains.repository.js";
import { entityPathsRepository } from "./repositories/entity-paths.repository.js";

export const observabilityIndexService = new ObservabilityIndexService({ elasticsearch });

export const analysisRequestValidationService = new AnalysisRequestValidationService({
  domainsRepository,
  entityPathsRepository
});
export const analysisCommandService = new AnalysisCommandService(
  analysisRequestValidationService,
  analysisRunsRepository,
  analysisRunItemsRepository,
  analysisRunQueue
);
export const analysisStatusService = new AnalysisStatusService(analysisRunsRepository, analysisRunItemsRepository);
export const analysisRunStatusAggregatorService = new AnalysisRunStatusAggregatorService(
  analysisRunsRepository,
  analysisRunItemsRepository
);
export const analysisRunOrchestratorService = new AnalysisRunOrchestratorService(
  analysisRunsRepository,
  analysisRunItemsRepository,
  analysisRunItemQueue,
  analysisRunStatusAggregatorService
);
export const analysisRunItemExecutionService = new AnalysisRunItemExecutionService(
  analysisRunItemsRepository,
  analysisRunStatusAggregatorService
);
export const discoveryCommandService = new DiscoveryCommandService(discoveryRequestsRepository);

export const domainSchedulerService = new DomainSchedulerService();

export const notificationService = new NotificationService({
  notificationsRepository,
  notificationQueue,
  observabilityIndexService
});
