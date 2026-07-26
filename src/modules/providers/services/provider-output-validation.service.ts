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

export function validateProviderOutput(input: {
  generatedContent: string;
  promptType: PromptType;
  promptDepth: PromptDepth;
  responseContractVersion: string;
  exactTargetName: string;
}): ProviderOutputValidation {
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
    input.exactTargetName
  );
  if (semanticErrors.length > 0) {
    return {
      valid: false,
      validatedResponse: null,
      validationErrors: semanticErrors,
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
  exactTargetName: string
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
    if (result.found === true && rankPosition !== null) {
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
  return errors;
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
