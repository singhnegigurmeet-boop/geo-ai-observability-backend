import { z } from "zod";
import { ApplicationError } from "../errors/application-error.js";
import type { RequestHandler } from "express";

const databaseId = z
  .string()
  .regex(/^[1-9]\d*$/, "Must be a positive database identifier");

const providerName = z.enum(["mock", "openai", "gemini", "claude"]);
const providerModel = z.enum([
  "mock-fast",
  "mock-standard",
  "mock-quality",
  "gpt-4o-mini",
  "gemini-1.5-flash",
  "claude-3-5-sonnet"
]);

export const createAnalysisRequestSchema = z
  .object({
    domain: z.string().trim().min(1),
    categoryId: databaseId.optional(),
    brandId: databaseId.optional(),
    productId: databaseId.optional(),
    useContextId: databaseId.optional(),
    preferredProvider: providerName.optional(),
    preferredModel: providerModel.optional(),
    providerModels: z
      .array(
        z
          .object({
            provider: providerName,
            model: providerModel
          })
          .strict()
      )
      .min(1)
      .max(4)
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.providerModels &&
      (value.preferredProvider !== undefined ||
        value.preferredModel !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerModels"],
        message:
          "providerModels cannot be combined with legacy preferredProvider/preferredModel"
      });
    }
    for (const [index, pair] of (value.providerModels ?? []).entries()) {
      const expectedProvider = pair.model.startsWith("mock-")
        ? "mock"
        : pair.model === "gpt-4o-mini"
          ? "openai"
          : pair.model === "gemini-1.5-flash"
            ? "gemini"
            : "claude";
      if (pair.provider !== expectedProvider) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providerModels", index, "model"],
          message: "Provider and model must be an allowed exact pair"
        });
      }
    }
    const modelProvider = value.preferredModel?.startsWith("mock-")
      ? "mock"
      : value.preferredModel === "gpt-4o-mini"
        ? "openai"
        : value.preferredModel === "gemini-1.5-flash"
          ? "gemini"
          : value.preferredModel === "claude-3-5-sonnet"
            ? "claude"
            : null;
    if (
      value.preferredProvider &&
      value.preferredProvider !== "mock" &&
      modelProvider !== value.preferredProvider
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preferredModel"],
        message: "Real provider selection requires its exact allowed model"
      });
    }
    if (
      modelProvider &&
      value.preferredProvider &&
      modelProvider !== value.preferredProvider
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preferredModel"],
        message: "preferredProvider and preferredModel must match"
      });
    }
    if (modelProvider && modelProvider !== "mock" && !value.preferredProvider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preferredProvider"],
        message: "preferredModel requires preferredProvider"
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
