import { z } from "zod";
import { ApplicationError } from "../errors/application-error.js";
import type { RequestHandler } from "express";

const databaseId = z
  .string()
  .regex(/^[1-9]\d*$/, "Must be a positive database identifier");

export const createAnalysisRequestSchema = z
  .object({
    domain: z.string().trim().min(1),
    categoryId: databaseId.optional(),
    brandId: databaseId.optional(),
    productId: databaseId.optional(),
    useContextId: databaseId.optional(),
    preferredProvider: z.literal("mock").optional(),
    preferredModel: z
      .enum(["mock-fast", "mock-standard", "mock-quality"])
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.brandId && !value.categoryId) {
      addDependencyIssue(context, "brandId", "categoryId");
    }
    if (value.productId && !value.brandId) {
      addDependencyIssue(context, "productId", "brandId");
    }
    if (value.useContextId && !value.productId) {
      addDependencyIssue(context, "useContextId", "productId");
    }
  });

export const analysisRunParamsSchema = z.object({
  analysisRunId: databaseId
});

export function parseIdempotencyKey(value: string | undefined) {
  const key = value?.trim();
  if (!key) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      "Idempotency-Key header is required"
    );
  }
  if (key.length > 255 || key.includes(",")) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      "Idempotency-Key must contain one value of at most 255 characters"
    );
  }
  return key;
}

export const validateIdempotencyKeyHeader: RequestHandler = (
  request,
  _response,
  next
) => {
  try {
    parseIdempotencyKey(request.get("idempotency-key"));
    next();
  } catch (error) {
    next(error);
  }
};

function addDependencyIssue(
  context: z.RefinementCtx,
  field: string,
  dependency: string
) {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [field],
    message: `${field} requires ${dependency}`
  });
}

export type CreateAnalysisRequest = z.infer<
  typeof createAnalysisRequestSchema
>;
