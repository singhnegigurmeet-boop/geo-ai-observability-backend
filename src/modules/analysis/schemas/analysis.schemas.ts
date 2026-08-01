import { z } from "zod";
import { ApplicationError } from "../../../common/errors/application-error.js";
import type { RequestHandler } from "express";
import { MAX_ANALYSIS_PROVIDER_MODELS } from "../../providers/registry/provider-model.registry.js";

const databaseId = z
  .string()
  .regex(/^[1-9]\d*$/, "Must be a positive database identifier");

const providerName = z.enum(["mock", "openai", "gemini", "claude"]);
const categorySelection = z.union([
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("selected"),
      categoryIds: z.array(databaseId).min(1).max(50)
    })
    .strict()
]);

const providerModelSelection = z.union([
  z.object({ provider: providerName, model: z.string().trim().min(1).max(255) }).strict(),
  z.object({ provider: providerName, selection: z.literal("all") }).strict()
]);

export const createAnalysisRequestSchema = z
  .object({
    domain: z.string().trim().min(1),
    categoryId: databaseId.optional(),
    brandId: databaseId.optional(),
    productId: databaseId.optional(),
    useContextId: databaseId.optional(),
    categorySelection: categorySelection.default({ mode: "all" }),
    promptDepth: z.enum(["weak", "medium", "high"]).optional(),
    providerModels: z
      .array(providerModelSelection)
      .min(1)
      .max(MAX_ANALYSIS_PROVIDER_MODELS)
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.categorySelection.mode === "selected" &&
      new Set(value.categorySelection.categoryIds).size !==
        value.categorySelection.categoryIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categorySelection", "categoryIds"],
        message: "Duplicate category IDs are not allowed"
      });
    }
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

export const hierarchyNavigationRequestSchema = z
  .object({
    domain: z.string().trim().min(1),
    categoryId: databaseId.optional(),
    brandId: databaseId.optional(),
    productId: databaseId.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.brandId && !value.categoryId) {
      addDependencyIssue(context, "brandId", "categoryId");
    }
    if (value.productId && !value.brandId) {
      addDependencyIssue(context, "productId", "brandId");
    }
  });

export const analysisRunParamsSchema = z.object({
  analysisRunId: databaseId
});
export const preAnalysisRequestParamsSchema = z.object({ preAnalysisRequestId: databaseId });

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

type ParsedCreateAnalysisRequest = z.infer<typeof createAnalysisRequestSchema>;
export type CreateAnalysisRequest = Omit<
  ParsedCreateAnalysisRequest,
  "categorySelection"
> & {
  categorySelection?: ParsedCreateAnalysisRequest["categorySelection"];
};
export type HierarchyNavigationRequest = z.infer<typeof hierarchyNavigationRequestSchema>;
