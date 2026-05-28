import type { AnalysisRequest } from "../modules/analysis/types/v6-analysis-request.js";

export type AnalysisJobData = {
  analysisRunId?: number;
  request: AnalysisRequest;
};

export type SchedulerJobData = {
  triggeredAt: string;
};

export type NotificationJobData = {
  notificationId: number;
};
