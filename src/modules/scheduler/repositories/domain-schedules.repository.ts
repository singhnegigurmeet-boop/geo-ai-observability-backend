import { BaseRepository } from "../../../repositories/base.repository.js";
import { SQL_QUERIES } from "../../../db/sql-queries.js";
import type { DomainScheduleRow } from "../../../types/database.types.js";

export class DomainSchedulesRepository extends BaseRepository<DomainScheduleRow> {
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
