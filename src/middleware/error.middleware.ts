import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { ApplicationError } from "../errors/application-error.js";
import { apiError, sendApiResult } from "../utils/api-response.js";

export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    sendApiResult(res, apiError(400, "Invalid request body", error.flatten()));
    return;
  }

  if (error instanceof ApplicationError) {
    sendApiResult(
      res,
      apiError(error.statusCode, error.message, { category: error.category })
    );
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected error";

  sendApiResult(res, apiError(500, message));
};
