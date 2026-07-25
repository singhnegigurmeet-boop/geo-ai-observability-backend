import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

export function validateBody(schema: ZodSchema): RequestHandler {
  return (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
  };
}

export function validateParams(schema: ZodSchema): RequestHandler {
  return (req, _res, next) => {
    (req as unknown as { params: unknown }).params = schema.parse(req.params);
    next();
  };
}
