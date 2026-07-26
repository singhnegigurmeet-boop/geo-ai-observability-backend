export type ApiResult<TBody = unknown> = {
  statusCode: number;
  body: TBody;
};

export type ApiErrorBody = {
  status: "error";
  code: string;
  error: string;
  details?: unknown;
};
