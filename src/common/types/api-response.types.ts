export type ApiResult<TBody = unknown> = {
  statusCode: number;
  body: TBody;
};

export type ApiErrorBody = {
  status: "error";
  error: string;
  details?: unknown;
};
