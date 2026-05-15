import type { Queue } from "bullmq";
import { AnalysisRunsRepository } from "../../analysis/repositories/analysis-runs.repository.js";
import { DomainSchedulesRepository } from "../repositories/domain-schedules.repository.js";
import { ObservabilityIndexService } from "../../observability/services/observability-index.service.js";
import type { AnalysisJobData } from "../../../types/queue.types.js";
import type { DomainScheduleRow } from "../../../types/database.types.js";

type DomainSchedulerServiceDependencies = {
  analysisRunsRepository: AnalysisRunsRepository;
  domainSchedulesRepository: DomainSchedulesRepository;
  analysisQueue: Queue<AnalysisJobData>;
  observabilityIndexService: ObservabilityIndexService;
};

export class DomainSchedulerService {
  constructor(private readonly dependencies: DomainSchedulerServiceDependencies) {}

  async enqueueDueDomains() {
    const dueSchedules = await this.dependencies.domainSchedulesRepository.findDueSchedules();
    const enqueued: Array<{ scheduleId: number; analysisRunId: number; domain: string }> = [];

    for (const schedule of dueSchedules) {
      const analysisRun = await this.dependencies.analysisRunsRepository.createQueuedRun(
        schedule.domain_id,
        "scheduled"
      );
      const bullMqJobId = `analysis-run-${analysisRun.id}-${Date.now()}`;
      const job = await this.dependencies.analysisQueue.add(
        "analyze-domain",
        {
          analysisRunId: analysisRun.id,
          domainId: schedule.domain_id,
          domain: schedule.domain
        },
        { jobId: bullMqJobId }
      );

      await this.dependencies.analysisRunsRepository.attachBullMqJob(analysisRun.id, bullMqJobId);
      const updatedSchedule = await this.dependencies.domainSchedulesRepository.markEnqueued(
        schedule.id,
        this.getNextRunAt(schedule)
      );

      await this.dependencies.observabilityIndexService.indexScheduledRun({
        event: "scheduled_run_enqueued",
        schedule_id: schedule.id,
        domain_id: schedule.domain_id,
        domain: schedule.domain,
        analysis_run_id: analysisRun.id,
        bullmq_job_id: bullMqJobId,
        cadence: schedule.cadence,
        previous_next_run_at: schedule.next_run_at.toISOString(),
        next_run_at: updatedSchedule.next_run_at.toISOString(),
        timestamp: new Date().toISOString()
      });

      enqueued.push({
        scheduleId: schedule.id,
        analysisRunId: analysisRun.id,
        domain: schedule.domain
      });
    }

    if (enqueued.length > 0) {
      console.log(`Scheduled ${enqueued.length} domain analysis run(s)`, enqueued);
    }

    return enqueued;
  }

  private getNextRunAt(schedule: DomainScheduleRow) {
    const nextRunAt = new Date();

    if (schedule.cadence === "weekly") {
      nextRunAt.setUTCDate(nextRunAt.getUTCDate() + 7);
      return nextRunAt;
    }

    return nextRunAt;
  }
}
