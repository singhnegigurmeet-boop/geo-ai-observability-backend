export type AnalysisRunJobPayload = {
  analysisRunId: number;
};

export type AnalysisRunItemJobPayload = {
  analysisRunId: number;
  runItemId: number;
};

export type SchedulerJobData = {
  triggeredAt: string;
};

export type NotificationJobData = {
  notificationId: number;
};
