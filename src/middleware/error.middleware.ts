import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: "Invalid request body",
      details: error.flatten()
    });
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected error";

  res.status(500).json({
    error: message
  });
};
