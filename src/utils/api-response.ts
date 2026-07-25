import type { Response } from "express";
import type { ApiErrorBody, ApiResult } from "../common/types/api-response.types.js";

export function apiResult<TBody>(statusCode: number, body: TBody): ApiResult<TBody> {
  return { statusCode, body };
}

export function apiError(statusCode: number, error: string, details?: unknown): ApiResult<ApiErrorBody> {
  return {
    statusCode,
    body: {
      status: "error",
      error,
      ...(details === undefined ? {} : { details })
    }
  };
}

export function sendApiResult<TBody>(res: Response, result: ApiResult<TBody>): void {
  res.status(result.statusCode).json(result.body);
}
