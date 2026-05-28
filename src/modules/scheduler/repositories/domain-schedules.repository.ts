import { BaseRepository } from "../../../repositories/base.repository.js";
import { SQL_QUERIES } from "../../../db/sql-queries.js";
import type { DomainScheduleInput, DomainScheduleRow } from "../../../types/database.types.js";

export class DomainSchedulesRepository extends BaseRepository<DomainScheduleRow> {
  async upsertSchedule(input: DomainScheduleInput) {
    return this.executeSingleQueryOrThrow<DomainScheduleRow>(
      SQL_QUERIES.domainSchedules.upsert,
      [input.domainId, input.cadence, input.enabled, input.nextRunAt],
      "Failed to upsert domain schedule"
    );
  }

  async findAllSchedules(limit = 100, offset = 0) {
    return this.executeQuery<DomainScheduleRow>(
      SQL_QUERIES.domainSchedules.findAll,
      [limit, offset]
    );
  }

  async setEnabled(scheduleId: number, enabled: boolean) {
    return this.executeSingleQuery<DomainScheduleRow>(
      SQL_QUERIES.domainSchedules.setEnabled,
      [scheduleId, enabled]
    );
  }

  async findDueSchedules(limit = 50) {
    return this.executeQuery<DomainScheduleRow>(
      SQL_QUERIES.domainSchedules.findDue,
      [limit]
    );
  }

  async markEnqueued(scheduleId: number, nextRunAt: Date) {
    return this.executeSingleQueryOrThrow<DomainScheduleRow>(
      SQL_QUERIES.domainSchedules.markEnqueued,
      [scheduleId, nextRunAt],
      "Failed to update domain schedule"
    );
  }
}

export const domainSchedulesRepository = new DomainSchedulesRepository();
