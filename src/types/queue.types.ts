export type AnalysisJobData = {
  analysisRunId: number;
  domainId: number;
  domain: string;
};

export type SchedulerJobData = {
  triggeredAt: string;
};

export type NotificationJobData = {
  notificationId: number;
};
