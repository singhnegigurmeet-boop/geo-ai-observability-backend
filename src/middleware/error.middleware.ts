import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { apiError, sendApiResult } from "../utils/api-response.js";

export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    sendApiResult(res, apiError(400, "Invalid request body", error.flatten()));
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected error";

  sendApiResult(res, apiError(500, message));
};
