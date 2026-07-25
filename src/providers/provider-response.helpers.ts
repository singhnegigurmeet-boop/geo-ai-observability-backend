import type { JsonObject } from "../types/database.types.js";
import { ProviderExecutionError } from "./provider-execution.error.js";

export function asObject(value: unknown, provider: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformed(provider);
  }
  return value as JsonObject;
}

export function objectAt(
  value: unknown,
  provider: string
): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function stringAt(value: unknown) {
  return typeof value === "string" ? value : null;
}

export function nonnegativeInteger(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

export function normalizedEvidence(input: {
  provider: string;
  model: string;
  promptType: string;
  text: string;
  refusal?: boolean;
}): JsonObject {
  return {
    provider: input.provider,
    model: input.model,
    promptType: input.promptType,
    answer: input.text,
    refusal: input.refusal ?? false,
    evidence: [
      {
        claim: input.text,
        source: `${input.provider}-provider`,
        confidence: input.refusal ? 0 : 0.5
      }
    ]
  };
}

export function malformed(provider: string): ProviderExecutionError {
  return new ProviderExecutionError(
    "MALFORMED_PROVIDER_RESPONSE",
    `${provider} returned a response that could not be normalized`,
    true
  );
}
