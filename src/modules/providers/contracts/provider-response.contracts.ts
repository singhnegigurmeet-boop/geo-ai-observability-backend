import { z } from "zod";
import type {
  JsonObject,
  PromptType
} from "../../../common/types/database.types.js";

export const HIERARCHY_DISCOVERY_POLICY_VERSION = "hierarchy-discovery-policy-v1";
export const HIERARCHY_DISCOVERY_PROMPT_VERSIONS = {
  category: "hierarchy-discovery-category-v1",
  brand: "hierarchy-discovery-brand-v1",
  product: "hierarchy-discovery-product-v1",
  use_context: "hierarchy-discovery-use-context-v1"
} as const;
export const HIERARCHY_DISCOVERY_CONTRACT_VERSIONS = {
  category: "hierarchy-discovery-category-response-v1",
  brand: "hierarchy-discovery-brand-response-v1",
  product: "hierarchy-discovery-product-response-v1",
  use_context: "hierarchy-discovery-use-context-response-v1"
} as const;

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

const rankedSelection = z.object({
  category_id: positiveDatabaseId,
  rank: z.number().int().positive(),
  confidence,
  reason: boundedText(1_000)
}).strict();
const rankedName = z.object({
  name: boundedText(500),
  rank: z.number().int().positive(),
  confidence,
  reason: boundedText(1_000)
}).strict();
const useContextSelection = z.object({
  use_context_id: positiveDatabaseId,
  rank: z.number().int().positive(),
  confidence,
  reason: boundedText(1_000)
}).strict();

export const hierarchyDiscoveryResponseSchemas = {
  category: discoverySchema("hierarchy_discovery_category", HIERARCHY_DISCOVERY_CONTRACT_VERSIONS.category, "selections", rankedSelection, 50),
  brand: discoverySchema("hierarchy_discovery_brand", HIERARCHY_DISCOVERY_CONTRACT_VERSIONS.brand, "items", rankedName, 5),
  product: discoverySchema("hierarchy_discovery_product", HIERARCHY_DISCOVERY_CONTRACT_VERSIONS.product, "items", rankedName, 5),
  use_context: discoverySchema("hierarchy_discovery_use_context", HIERARCHY_DISCOVERY_CONTRACT_VERSIONS.use_context, "selections", useContextSelection, 50)
} as const;

function discoverySchema(promptType: string, contractVersion: string, field: "items" | "selections", item: z.ZodTypeAny, maximum: number) {
  return z.object({
    prompt_type: z.literal(promptType),
    contract_version: z.literal(contractVersion),
    [field]: z.array(item).max(maximum),
    summary: z.string().trim().max(2_000)
  }).strict().superRefine((value, context) => {
    const rows = value[field] as Array<{ rank: number; name?: string; category_id?: string; use_context_id?: string }>;
    const identities = rows.map((row) => row.name?.trim().toLowerCase() ?? row.category_id ?? row.use_context_id);
    const ranks = rows.map((row) => row.rank);
    if (new Set(identities).size !== identities.length) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Discovery identities must be unique" });
    if (new Set(ranks).size !== ranks.length || [...ranks].sort((a,b)=>a-b).some((rank,index)=>rank!==index+1)) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "Discovery ranks must be contiguous from 1" });
  });
}

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

export function hierarchyDiscoveryResponseJsonSchema(stage: keyof typeof HIERARCHY_DISCOVERY_CONTRACT_VERSIONS): JsonObject {
  const controlled = stage === "category" || stage === "use_context";
  const field = stage === "brand" || stage === "product" ? "items" : "selections";
  const identityField = stage === "category" ? "category_id" : stage === "use_context" ? "use_context_id" : "name";
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt_type: {
        type: "string",
        const: `hierarchy_discovery_${stage}`
      },
      contract_version: {
        type: "string",
        const: HIERARCHY_DISCOVERY_CONTRACT_VERSIONS[stage]
      },
      [field]: {
        type: "array",
        maxItems: controlled ? 50 : 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            [identityField]: controlled
              ? { type: "string", pattern: "^[1-9][0-9]*$" }
              : { type: "string", minLength: 1, maxLength: 500 },
            rank: { type: "integer", minimum: 1 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string", minLength: 1, maxLength: 1_000 }
          },
          required: [identityField, "rank", "confidence", "reason"]
        }
      },
      summary: { type: "string", maxLength: 2_000 }
    },
    required: ["prompt_type", "contract_version", field, "summary"]
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
