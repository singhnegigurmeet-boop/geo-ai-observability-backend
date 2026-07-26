import { z } from "zod";
import type {
  JsonObject,
  PromptType
} from "../../../common/types/database.types.js";

export const DOMAIN_CATEGORY_CLASSIFICATION_PROMPT_VERSION =
  "domain-category-classification-v1";
export const DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION =
  "domain-category-classification-response-v1";

const positiveDatabaseId = z.string().regex(/^[1-9]\d*$/);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const confidence = z.number().finite().min(0).max(1);
const boundedStringArray = (maximumItems: number, maximumLength = 500) =>
  z.array(boundedText(maximumLength)).max(maximumItems);

export const evidenceItemSchema = z
  .object({
    claim: boundedText(1_000),
    source: boundedText(500),
    confidence
  })
  .strict();

export const domainCategoryClassificationResponseSchema = z
  .object({
    prompt_type: z.literal("domain_category_classification"),
    contract_version: z.literal(
      DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION
    ),
    matches: z
      .array(
        z
          .object({
            category_id: positiveDatabaseId,
            rank: z.number().int().positive(),
            confidence,
            reason: boundedText(1_000)
          })
          .strict()
      )
      .max(50),
    summary: z.string().trim().max(2_000)
  })
  .strict()
  .superRefine((value, context) => {
    const categoryIds = new Set<string>();
    const ranks = new Set<number>();
    for (const [index, match] of value.matches.entries()) {
      if (categoryIds.has(match.category_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matches", index, "category_id"],
          message: "Classification category IDs must be unique"
        });
      }
      categoryIds.add(match.category_id);
      if (ranks.has(match.rank)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matches", index, "rank"],
          message: "Classification ranks must be unique"
        });
      }
      ranks.add(match.rank);
    }
    const orderedRanks = [...ranks].sort((left, right) => left - right);
    if (orderedRanks.some((rank, index) => rank !== index + 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["matches"],
        message: "Classification ranks must be contiguous starting at 1"
      });
    }
  });

const commonEnvelope = {
  evidence: z.array(evidenceItemSchema).max(20),
  summary: z.string().trim().max(2_000)
};

export const visibilityResponseSchema = z
  .object({
    prompt_type: z.literal("visibility"),
    contract_version: z.literal("visibility-response-v1"),
    result: z
      .object({
        target_mentioned: z.boolean(),
        mention_likelihood: confidence,
        recommendation_likelihood: confidence,
        competitive_prominence: confidence,
        query_intents: boundedStringArray(20),
        strengths: boundedStringArray(20),
        visibility_gaps: boundedStringArray(20),
        confidence
      })
      .strict(),
    ...commonEnvelope
  })
  .strict();

export const rankingResponseSchema = z
  .object({
    prompt_type: z.literal("ranking"),
    contract_version: z.literal("ranking-response-v1"),
    result: z
      .object({
        requested_top_k: z.number().int().min(1).max(50),
        found: z.boolean(),
        rank_position: z.number().int().min(1).max(50).nullable(),
        ordered_candidates: z
          .array(
            z
              .object({
                rank: z.number().int().positive(),
                name: boundedText(500)
              })
              .strict()
          )
          .max(50),
        mention_count: z.number().int().nonnegative(),
        confidence
      })
      .strict()
      .superRefine((result, context) => {
        if (result.found && result.rank_position === null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["rank_position"],
            message: "A found target requires rank_position"
          });
        }
        if (!result.found && result.rank_position !== null) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["rank_position"],
            message: "A missing target requires rank_position=null"
          });
        }
        const ranks = result.ordered_candidates.map((item) => item.rank);
        if (
          new Set(ranks).size !== ranks.length ||
          [...ranks].sort((a, b) => a - b).some((rank, index) => rank !== index + 1)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["ordered_candidates"],
            message: "Candidate ranks must be unique and contiguous from 1"
          });
        }
      }),
    ...commonEnvelope
  })
  .strict();

const competitorSchema = z
  .object({
    name: boundedText(500),
    relevance_rank: z.number().int().positive(),
    reason_for_overlap: boundedText(1_000),
    confidence
  })
  .strict();

export const competitorResponseSchema = z
  .object({
    prompt_type: z.literal("competitor"),
    contract_version: z.literal("competitor-response-v1"),
    result: z
      .object({
        direct_competitors: z.array(competitorSchema).max(20),
        indirect_competitors: z.array(competitorSchema).max(20),
        target_differentiation: boundedText(2_000),
        competitive_pressure: confidence,
        confidence
      })
      .strict(),
    ...commonEnvelope
  })
  .strict();

export const priceRangeResponseSchema = z
  .object({
    prompt_type: z.literal("price_range"),
    contract_version: z.literal("price-range-response-v1"),
    result: z
      .object({
        applicability: z.enum(["applicable", "not_applicable", "unknown"]),
        currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
        minimum: z.number().finite().nonnegative().nullable(),
        maximum: z.number().finite().nonnegative().nullable(),
        pricing_basis: boundedText(1_000),
        uncertainty: boundedText(1_000),
        confidence
      })
      .strict()
      .superRefine((result, context) => {
        if (
          result.minimum !== null &&
          result.maximum !== null &&
          result.minimum > result.maximum
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["maximum"],
            message: "maximum must be greater than or equal to minimum"
          });
        }
        if (
          result.applicability !== "applicable" &&
          (result.currency !== null ||
            result.minimum !== null ||
            result.maximum !== null)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["applicability"],
            message: "Non-applicable or unknown pricing must use null values"
          });
        }
      }),
    ...commonEnvelope
  })
  .strict();

export const prosConsResponseSchema = z
  .object({
    prompt_type: z.literal("pros_cons"),
    contract_version: z.literal("pros-cons-response-v1"),
    result: z
      .object({
        pros: boundedStringArray(20),
        cons: boundedStringArray(20),
        best_fit_for: boundedStringArray(20),
        poor_fit_for: boundedStringArray(20),
        comparison_context: boundedText(2_000),
        confidence
      })
      .strict(),
    ...commonEnvelope
  })
  .strict();

export const NORMAL_RESPONSE_SCHEMAS = {
  visibility: visibilityResponseSchema,
  ranking: rankingResponseSchema,
  competitor: competitorResponseSchema,
  price_range: priceRangeResponseSchema,
  pros_cons: prosConsResponseSchema
} as const;

export type DomainCategoryClassificationResponse = z.infer<
  typeof domainCategoryClassificationResponseSchema
>;

export function parseGeneratedJson(generatedContent: string): unknown {
  return JSON.parse(generatedContent) as unknown;
}

export function validateNormalResponse(
  promptType: PromptType,
  value: unknown
) {
  return NORMAL_RESPONSE_SCHEMAS[promptType].safeParse(value);
}

/**
 * Provider-native enforcement is defense in depth. The Zod schemas above
 * remain authoritative after transport, parsing and semantic validation.
 */
export function normalResponseJsonSchema(
  promptType: PromptType,
  contractVersion: string
): JsonObject {
  const confidenceSchema = { type: "number", minimum: 0, maximum: 1 };
  const stringArray = {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 500 },
    maxItems: 20
  };
  const resultProperties: Record<PromptType, Record<string, unknown>> = {
    visibility: {
      target_mentioned: { type: "boolean" },
      mention_likelihood: confidenceSchema,
      recommendation_likelihood: confidenceSchema,
      competitive_prominence: confidenceSchema,
      query_intents: stringArray,
      strengths: stringArray,
      visibility_gaps: stringArray,
      confidence: confidenceSchema
    },
    ranking: {
      requested_top_k: { type: "integer", minimum: 1, maximum: 50 },
      found: { type: "boolean" },
      rank_position: {
        anyOf: [
          { type: "integer", minimum: 1, maximum: 50 },
          { type: "null" }
        ]
      },
      ordered_candidates: {
        type: "array",
        maxItems: 50,
        items: strictObject({
          rank: { type: "integer", minimum: 1 },
          name: { type: "string", minLength: 1, maxLength: 500 }
        })
      },
      mention_count: { type: "integer", minimum: 0 },
      confidence: confidenceSchema
    },
    competitor: {
      direct_competitors: competitorJsonArray(confidenceSchema),
      indirect_competitors: competitorJsonArray(confidenceSchema),
      target_differentiation: {
        type: "string",
        minLength: 1,
        maxLength: 2_000
      },
      competitive_pressure: confidenceSchema,
      confidence: confidenceSchema
    },
    price_range: {
      applicability: {
        type: "string",
        enum: ["applicable", "not_applicable", "unknown"]
      },
      currency: {
        anyOf: [{ type: "string", pattern: "^[A-Z]{3}$" }, { type: "null" }]
      },
      minimum: nullableNonnegativeNumber(),
      maximum: nullableNonnegativeNumber(),
      pricing_basis: { type: "string", minLength: 1, maxLength: 1_000 },
      uncertainty: { type: "string", minLength: 1, maxLength: 1_000 },
      confidence: confidenceSchema
    },
    pros_cons: {
      pros: stringArray,
      cons: stringArray,
      best_fit_for: stringArray,
      poor_fit_for: stringArray,
      comparison_context: {
        type: "string",
        minLength: 1,
        maxLength: 2_000
      },
      confidence: confidenceSchema
    }
  };
  return strictObject({
    prompt_type: { type: "string", const: promptType },
    contract_version: { type: "string", const: contractVersion },
    result: strictObject(resultProperties[promptType]),
    evidence: {
      type: "array",
      maxItems: 20,
      items: strictObject({
        claim: { type: "string", minLength: 1, maxLength: 1_000 },
        source: { type: "string", minLength: 1, maxLength: 500 },
        confidence: confidenceSchema
      })
    },
    summary: { type: "string", maxLength: 2_000 }
  }) as JsonObject;
}

export function classificationResponseJsonSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt_type: {
        type: "string",
        const: "domain_category_classification"
      },
      contract_version: {
        type: "string",
        const: DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION
      },
      matches: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            category_id: { type: "string", pattern: "^[1-9][0-9]*$" },
            rank: { type: "integer", minimum: 1 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string", minLength: 1, maxLength: 1_000 }
          },
          required: ["category_id", "rank", "confidence", "reason"]
        }
      },
      summary: { type: "string", maxLength: 2_000 }
    },
    required: ["prompt_type", "contract_version", "matches", "summary"]
  };
}

function strictObject(properties: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties)
  };
}

function competitorJsonArray(confidenceSchema: Record<string, unknown>) {
  return {
    type: "array",
    maxItems: 20,
    items: strictObject({
      name: { type: "string", minLength: 1, maxLength: 500 },
      relevance_rank: { type: "integer", minimum: 1 },
      reason_for_overlap: {
        type: "string",
        minLength: 1,
        maxLength: 1_000
      },
      confidence: confidenceSchema
    })
  };
}

function nullableNonnegativeNumber() {
  return {
    anyOf: [{ type: "number", minimum: 0 }, { type: "null" }]
  };
}
