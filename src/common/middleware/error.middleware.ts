import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { ApplicationError } from "../errors/application-error.js";
import { apiError, sendApiResult } from "../../utils/api-response.js";

export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    sendApiResult(
      res,
      apiError(
        400,
        "VALIDATION_ERROR",
        "Invalid request body",
        error.flatten()
      )
    );
    return;
  }

  if (error instanceof ApplicationError) {
    sendApiResult(
      res,
      apiError(
        error.statusCode,
        error.category,
        error.message,
        { category: error.category }
      )
    );
    return;
  }

  sendApiResult(
    res,
    apiError(
      500,
      "INTERNAL_ERROR",
      "An unexpected internal error occurred."
    )
  );
};
