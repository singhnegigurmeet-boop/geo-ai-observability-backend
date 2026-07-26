import type {
  JsonObject,
  JsonValue,
  PromptDepth,
  PromptType
} from "../../../common/types/database.types.js";
import { PROMPT_DEPTH_LIMITS } from "../../prompts/policies/prompt-policy.registry.js";
import {
  domainCategoryClassificationResponseSchema,
  parseGeneratedJson,
  validateNormalResponse
} from "../contracts/provider-response.contracts.js";
import {
  entityPathContextSchema,
  entityPathTarget
} from "../../prompts/contracts/entity-path-context.contract.js";
import type { AuthoritativeEntityPathContextResult } from "../repositories/authoritative-entity-path-context.repository.js";

export const MAX_RETAINED_GENERATED_CONTENT_BYTES = 256 * 1024;

export type RetainedGeneratedContent = {
  rawResponse: string;
  rawResponseTruncated: boolean;
  rawResponseOriginalBytes: number;
};

export type ProviderOutputValidation =
  | {
      valid: true;
      validatedResponse: JsonObject;
      validationErrors: [];
      contextValidationStatus: "valid";
    }
  | {
      valid: false;
      validatedResponse: null;
      validationErrors: JsonValue[];
      contextValidationStatus: "invalid";
    };

export function retainGeneratedContent(
  generatedContent: string
): RetainedGeneratedContent {
  const originalBytes = Buffer.byteLength(generatedContent, "utf8");
  if (originalBytes <= MAX_RETAINED_GENERATED_CONTENT_BYTES) {
    return {
      rawResponse: generatedContent,
      rawResponseTruncated: false,
      rawResponseOriginalBytes: originalBytes
    };
  }
  let retained = "";
  let retainedBytes = 0;
  for (const character of generatedContent) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (retainedBytes + bytes > MAX_RETAINED_GENERATED_CONTENT_BYTES) break;
    retained += character;
    retainedBytes += bytes;
  }
  return {
    rawResponse: retained,
    rawResponseTruncated: true,
    rawResponseOriginalBytes: originalBytes
  };
}

export type NormalProviderValidationInput = {
  generatedContent: string;
  promptType: PromptType;
  promptDepth: PromptDepth;
  responseContractVersion: string;
  frozenContext: unknown;
  authoritativeContext: AuthoritativeEntityPathContextResult;
  promptInputPayload: JsonObject;
};

export function validateProviderOutput(
  input: NormalProviderValidationInput
): ProviderOutputValidation {
  let parsed: unknown;
  try {
    parsed = parseGeneratedJson(input.generatedContent);
  } catch {
    return invalid("RAW_JSON_PARSE_ERROR", "Generated content is not valid JSON");
  }
  const contract = validateNormalResponse(input.promptType, parsed);
  if (!contract.success) {
    return {
      valid: false,
      validatedResponse: null,
      validationErrors: contract.error.issues.map((issue) => ({
        layer: "runtime_contract",
        code: issue.code,
        path: issue.path.join("."),
        message: issue.message
      })),
      contextValidationStatus: "invalid"
    };
  }
  if (contract.data.contract_version !== input.responseContractVersion) {
    return invalid(
      "CONTRACT_VERSION_MISMATCH",
      "Returned response contract does not match the frozen provider job"
    );
  }
  const semanticErrors = semanticValidation(
    input.promptType,
    input.promptDepth,
    contract.data as JsonObject,
    input.authoritativeContext.valid
      ? entityPathTarget(input.authoritativeContext.context).name
      : null
  );
  if (semanticErrors.length > 0) {
    return {
      valid: false,
      validatedResponse: null,
      validationErrors: semanticErrors,
      contextValidationStatus: "invalid"
    };
  }
  const contextErrors = validateEntityPathContext(input);
  if (contextErrors.length > 0) {
    return {
      valid: false,
      validatedResponse: null,
      validationErrors: contextErrors,
      contextValidationStatus: "invalid"
    };
  }
  return {
    valid: true,
    validatedResponse: contract.data as JsonObject,
    validationErrors: [],
    contextValidationStatus: "valid"
  };
}

export function validateClassificationOutput(input: {
  generatedContent: string;
  candidateIds: readonly string[];
  activeFrozenCategoryIds: ReadonlySet<string>;
}): ProviderOutputValidation {
  let parsed: unknown;
  try {
    parsed = parseGeneratedJson(input.generatedContent);
  } catch {
    return invalid("RAW_JSON_PARSE_ERROR", "Generated content is not valid JSON");
  }
  const contract = domainCategoryClassificationResponseSchema.safeParse(parsed);
  if (!contract.success) {
    return {
      valid: false,
      validatedResponse: null,
      validationErrors: contract.error.issues.map((issue) => ({
        layer: "runtime_contract",
        code: issue.code,
        path: issue.path.join("."),
        message: issue.message
      })),
      contextValidationStatus: "invalid"
    };
  }
  if (contract.data.matches.length > input.candidateIds.length) {
    return invalid(
      "CLASSIFICATION_MATCH_COUNT",
      "Match count exceeds frozen candidate count"
    );
  }
  const candidates = new Set(input.candidateIds);
  for (const match of contract.data.matches) {
    if (
      !candidates.has(match.category_id) ||
      !input.activeFrozenCategoryIds.has(match.category_id)
    ) {
      return invalid(
        "CLASSIFICATION_CATEGORY_CONTEXT",
        "Returned category is outside the active frozen candidate set"
      );
    }
  }
  return {
    valid: true,
    validatedResponse: contract.data as JsonObject,
    validationErrors: [],
    contextValidationStatus: "valid"
  };
}

function semanticValidation(
  promptType: PromptType,
  promptDepth: PromptDepth,
  response: JsonObject,
  exactTargetName: string | null
): JsonValue[] {
  const errors: JsonValue[] = [];
  const limits = PROMPT_DEPTH_LIMITS[promptDepth];
  const evidence = response.evidence as JsonValue[];
  const summary = response.summary as string;
  if (evidence.length > limits.maxEvidenceItems) {
    errors.push(error("DEPTH_EVIDENCE_LIMIT", "Evidence exceeds prompt-depth limit"));
  }
  if (summary.length > limits.maxSummaryCharacters) {
    errors.push(error("DEPTH_SUMMARY_LIMIT", "Summary exceeds prompt-depth limit"));
  }
  const result = response.result as JsonObject;
  const arrays =
    promptType === "visibility"
      ? ["query_intents", "strengths", "visibility_gaps"]
      : promptType === "pros_cons"
        ? ["pros", "cons", "best_fit_for", "poor_fit_for"]
        : [];
  for (const field of arrays) {
    if ((result[field] as JsonValue[]).length > limits.maxListItems) {
      errors.push(error("DEPTH_ARRAY_LIMIT", `${field} exceeds prompt-depth limit`));
    }
  }
  if (promptType === "ranking") {
    const topK = result.requested_top_k as number;
    const candidates = result.ordered_candidates as JsonObject[];
    const rankPosition = result.rank_position as number | null;
    if (topK !== limits.topK) {
      errors.push(error("RANKING_TOP_K_MISMATCH", "requested_top_k does not match the frozen depth"));
    }
    if (candidates.length > topK) {
      errors.push(error("RANKING_CANDIDATE_LIMIT", "Candidate count exceeds requested_top_k"));
    }
    if (rankPosition !== null && rankPosition > topK) {
      errors.push(error("RANKING_POSITION_RANGE", "rank_position exceeds requested_top_k"));
    }
    if (exactTargetName !== null) {
      const targetCandidates = candidates.filter(
        (candidate) =>
          normalizeName(candidate.name as string) ===
          normalizeName(exactTargetName)
      );
      if (targetCandidates.length > 1) {
        errors.push(
          error(
            "RANKING_TARGET_DUPLICATED",
            "The exact backend target appears more than once"
          )
        );
      }
      if (result.found === false && targetCandidates.length > 0) {
        errors.push(
          error(
            "RANKING_TARGET_MISMATCH",
            "A missing target cannot appear in ordered_candidates"
          )
        );
      }
    }
    if (
      exactTargetName !== null &&
      result.found === true &&
      rankPosition !== null
    ) {
      const ranked = candidates.find(
        (candidate) => candidate.rank === rankPosition
      );
      if (
        !ranked ||
        normalizeName(ranked.name as string) !== normalizeName(exactTargetName)
      ) {
        errors.push(error("RANKING_TARGET_MISMATCH", "rank_position is not occupied by the exact target"));
      }
    }
  }
  if (promptType === "competitor") {
    for (const field of ["direct_competitors", "indirect_competitors"]) {
      const competitors = result[field] as JsonObject[];
      if (competitors.length > limits.maxListItems) {
        errors.push(error("DEPTH_ARRAY_LIMIT", `${field} exceeds prompt-depth limit`));
      }
      const ranks = competitors.map((item) => item.relevance_rank as number);
      if (
        new Set(ranks).size !== ranks.length ||
        [...ranks].sort((a, b) => a - b).some((rank, index) => rank !== index + 1)
      ) {
        errors.push(error("COMPETITOR_RANKS_INVALID", `${field} ranks must be contiguous from 1`));
      }
    }
  }
  if (promptType === "price_range") {
    const applicability = result.applicability as string;
    const currency = result.currency as string | null;
    const minimum = result.minimum as number | null;
    const maximum = result.maximum as number | null;
    const hasNumericRange = minimum !== null || maximum !== null;
    if (
      applicability === "applicable" &&
      ((hasNumericRange && currency === null) ||
        (!hasNumericRange && currency !== null))
    ) {
      errors.push(
        error(
          "PRICE_RANGE_CURRENCY_INCONSISTENT",
          "Currency and numeric price range must be supplied together"
        )
      );
    }
  }
  return errors;
}

function validateEntityPathContext(
  input: NormalProviderValidationInput
): JsonValue[] {
  if (
    !Object.prototype.hasOwnProperty.call(
      input.promptInputPayload,
      "entityPathContext"
    ) ||
    input.promptInputPayload.entityPathContext === null
  ) {
    return [
      contextError(
        "ENTITY_PATH_CONTEXT_MISSING",
        "The prompt job has no frozen entity path context"
      )
    ];
  }
  if (
    input.promptInputPayload.entityPathContext !== input.frozenContext &&
    JSON.stringify(input.promptInputPayload.entityPathContext) !==
      JSON.stringify(input.frozenContext)
  ) {
    return [
      contextError(
        "ENTITY_PATH_CONTEXT_SCHEMA_INVALID",
        "The supplied frozen context is not the prompt job snapshot"
      )
    ];
  }
  const frozen = entityPathContextSchema.safeParse(input.frozenContext);
  if (!frozen.success) {
    return [
      {
        ...contextError(
          "ENTITY_PATH_CONTEXT_SCHEMA_INVALID",
          "The frozen entity path context violates its runtime contract"
        ),
        issues: frozen.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message
        }))
      }
    ];
  }
  if (!input.authoritativeContext.valid) {
    return input.authoritativeContext.errors;
  }
  const authoritative = input.authoritativeContext.context;
  const errors: JsonObject[] = [];
  compareEntity(
    errors,
    "ENTITY_PATH_DOMAIN_MISMATCH",
    frozen.data.domain,
    authoritative.domain,
    "domain"
  );
  compareEntity(
    errors,
    "ENTITY_PATH_CATEGORY_MISMATCH",
    frozen.data.category,
    authoritative.category,
    "category"
  );
  compareEntity(
    errors,
    "ENTITY_PATH_BRAND_MISMATCH",
    frozen.data.brand,
    authoritative.brand,
    "brand"
  );
  compareEntity(
    errors,
    "ENTITY_PATH_PRODUCT_MISMATCH",
    frozen.data.product,
    authoritative.product,
    "product"
  );
  compareEntity(
    errors,
    "ENTITY_PATH_USE_CONTEXT_MISMATCH",
    frozen.data.useContext,
    authoritative.useContext,
    "use context"
  );
  if (frozen.data.startingLevel !== authoritative.startingLevel) {
    errors.push(
      contextError(
        "ENTITY_PATH_STARTING_LEVEL_MISMATCH",
        "Frozen starting level differs from PostgreSQL authority"
      )
    );
  }
  if (frozen.data.targetLevel !== authoritative.targetLevel) {
    errors.push(
      contextError(
        "ENTITY_PATH_TARGET_LEVEL_MISMATCH",
        "Frozen target level differs from PostgreSQL authority"
      )
    );
  }
  if (frozen.data.canonicalPath !== authoritative.canonicalPath) {
    errors.push(
      contextError(
        "ENTITY_PATH_CANONICAL_PATH_MISMATCH",
        "Frozen canonical path differs from PostgreSQL authority"
      )
    );
  }
  return errors;
}

function compareEntity(
  errors: JsonObject[],
  code:
    | "ENTITY_PATH_DOMAIN_MISMATCH"
    | "ENTITY_PATH_CATEGORY_MISMATCH"
    | "ENTITY_PATH_BRAND_MISMATCH"
    | "ENTITY_PATH_PRODUCT_MISMATCH"
    | "ENTITY_PATH_USE_CONTEXT_MISMATCH",
  frozen: { id: string; name: string } | undefined,
  authoritative: { id: string; name: string } | undefined,
  label: string
) {
  if (
    frozen?.id !== authoritative?.id ||
    frozen?.name !== authoritative?.name
  ) {
    errors.push(
      contextError(
        code,
        `Frozen ${label} differs from PostgreSQL authority`
      )
    );
  }
}

function contextError(code: string, message: string): JsonObject {
  return { layer: "postgres_context", code, message };
}

function invalid(code: string, message: string): ProviderOutputValidation {
  return {
    valid: false,
    validatedResponse: null,
    validationErrors: [error(code, message)],
    contextValidationStatus: "invalid"
  };
}

function error(code: string, message: string): JsonObject {
  return { layer: "semantic_or_context", code, message };
}

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
