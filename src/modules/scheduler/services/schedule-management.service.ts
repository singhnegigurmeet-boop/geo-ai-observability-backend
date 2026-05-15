import { DomainsRepository } from "../../../repositories/domains.repository.js";
import { DomainSchedulesRepository } from "../repositories/domain-schedules.repository.js";
import type { DomainScheduleCadence } from "../../../types/database.types.js";

type ScheduleManagementServiceDependencies = {
  domainsRepository: DomainsRepository;
  domainSchedulesRepository: DomainSchedulesRepository;
};

export type UpsertScheduleInput = {
  domain: string;
  cadence: DomainScheduleCadence;
  enabled: boolean;
  nextRunAt: Date | null;
};

export class ScheduleManagementService {
  constructor(private readonly dependencies: ScheduleManagementServiceDependencies) {}

  async upsertSchedule(input: UpsertScheduleInput) {
    const normalizedDomain = this.normalizeDomain(input.domain);
    const domain = await this.dependencies.domainsRepository.upsertDomain(normalizedDomain);
    const schedule = await this.dependencies.domainSchedulesRepository.upsertSchedule({
      domainId: domain.id,
      cadence: input.cadence,
      enabled: input.enabled,
      nextRunAt: input.nextRunAt
    });

    return {
      statusCode: 200,
      body: {
        status: "scheduled",
        source: "domain_schedules",
        schedule: {
          ...schedule,
          domain: domain.domain
        }
      }
    };
  }

  async listSchedules(limit = 100, offset = 0) {
    const schedules = await this.dependencies.domainSchedulesRepository.findAllSchedules(limit, offset);

    return {
      statusCode: 200,
      body: {
        status: "found",
        source: "domain_schedules",
        schedules
      }
    };
  }

  async setScheduleEnabled(scheduleId: number, enabled: boolean) {
    const schedule = await this.dependencies.domainSchedulesRepository.setEnabled(scheduleId, enabled);

    if (!schedule) {
      return {
        statusCode: 404,
        body: {
          status: "not_found",
          error: "Schedule not found",
          schedule_id: scheduleId
        }
      };
    }

    return {
      statusCode: 200,
      body: {
        status: enabled ? "enabled" : "disabled",
        source: "domain_schedules",
        schedule
      }
    };
  }

  private normalizeDomain(input: string) {
    const trimmed = input.trim().toLowerCase();
    const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
    const withoutPath = withoutProtocol.split("/")[0] ?? "";
    const withoutPort = withoutPath.split(":")[0] ?? "";
    return withoutPort.replace(/^www\./, "");
  }
}
