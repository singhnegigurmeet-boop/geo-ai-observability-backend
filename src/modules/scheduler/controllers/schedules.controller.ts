import type { Request } from "express";
import { BaseController } from "../../../controllers/base.controller.js";
import type { ApiResult } from "../../../types/api-response.types.js";
import type { DomainScheduleCadence } from "../../../types/database.types.js";

export type ScheduleManagementPort = {
  upsertSchedule(input: {
    domain: string;
    cadence: DomainScheduleCadence;
    enabled: boolean;
    nextRunAt: Date | null;
  }): Promise<ApiResult>;
  listSchedules(limit?: number, offset?: number): Promise<ApiResult>;
  setScheduleEnabled(scheduleId: number, enabled: boolean): Promise<ApiResult>;
};

export class SchedulesController extends BaseController {
  constructor(private readonly scheduleManagementService: ScheduleManagementPort) {
    super();
  }

  async handleCreateScheduleRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);
    const body = req.body as {
      domain: string;
      cadence?: DomainScheduleCadence;
      enabled?: boolean;
      next_run_at?: string;
    };
    const result = await this.scheduleManagementService.upsertSchedule({
      domain: body.domain,
      cadence: body.cadence ?? "weekly",
      enabled: body.enabled ?? true,
      nextRunAt: body.next_run_at ? new Date(body.next_run_at) : null
    });

    this.logResponse(req, result.statusCode);
    return result;
  }

  async handleListSchedulesRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);
    const query = req.query as { limit?: string; offset?: string };
    const limit = query.limit ? Number(query.limit) : undefined;
    const offset = query.offset ? Number(query.offset) : undefined;
    const result = await this.scheduleManagementService.listSchedules(limit, offset);

    this.logResponse(req, result.statusCode);
    return result;
  }

  async handleSetScheduleEnabledRequest(req: Request): Promise<ApiResult> {
    this.logRequest(req);
    const params = req.params as unknown as { scheduleId: number };
    const body = req.body as { enabled: boolean };
    const result = await this.scheduleManagementService.setScheduleEnabled(params.scheduleId, body.enabled);

    this.logResponse(req, result.statusCode);
    return result;
  }
}
