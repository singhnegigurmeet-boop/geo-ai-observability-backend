import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_RETAINED_GENERATED_CONTENT_BYTES,
  retainGeneratedContent,
  validateClassificationOutput,
  validateProviderOutput
} from "../../../src/modules/providers/services/provider-output-validation.service.js";

describe("provider output validation boundary", () => {
  it("rejects malformed JSON before contract validation", () => {
    const result = validateProviderOutput({
      generatedContent: "{not-json",
      promptType: "visibility",
      promptDepth: "weak",
      responseContractVersion: "visibility-response-v1",
      exactTargetName: "Example"
    });
    assert.equal(result.valid, false);
    assert.equal(errorCode(result.validationErrors[0]), "RAW_JSON_PARSE_ERROR");
  });

  it("accepts a semantically valid frozen visibility contract", () => {
    const result = validateProviderOutput({
      generatedContent: JSON.stringify({
        prompt_type: "visibility",
        contract_version: "visibility-response-v1",
        result: {
          target_mentioned: true,
          mention_likelihood: 0.7,
          recommendation_likelihood: 0.6,
          competitive_prominence: 0.5,
          query_intents: ["discovery"],
          strengths: ["clear context"],
          visibility_gaps: [],
          confidence: 0.7
        },
        evidence: [
          {
            claim: "Bounded evidence",
            source: "provider",
            confidence: 0.7
          }
        ],
        summary: "Bounded summary"
      }),
      promptType: "visibility",
      promptDepth: "weak",
      responseContractVersion: "visibility-response-v1",
      exactTargetName: "Example"
    });
    assert.equal(result.valid, true);
  });

  it("rejects classification IDs outside the active frozen candidate set", () => {
    const result = validateClassificationOutput({
      generatedContent: JSON.stringify({
        prompt_type: "domain_category_classification",
        contract_version: "domain-category-classification-response-v1",
        matches: [
          {
            category_id: "99",
            rank: 1,
            confidence: 0.8,
            reason: "Not a supplied candidate"
          }
        ],
        summary: "One match"
      }),
      candidateIds: ["1", "2"],
      activeFrozenCategoryIds: new Set(["1", "2"])
    });
    assert.equal(result.valid, false);
    assert.equal(
      errorCode(result.validationErrors[0]),
      "CLASSIFICATION_CATEGORY_CONTEXT"
    );
  });

  it("retains a valid UTF-8 prefix within the 256 KiB evidence cap", () => {
    const generated = `${"a".repeat(
      MAX_RETAINED_GENERATED_CONTENT_BYTES - 1
    )}tail`;
    const retained = retainGeneratedContent(generated);
    assert.equal(retained.rawResponseTruncated, true);
    assert.ok(
      Buffer.byteLength(retained.rawResponse, "utf8") <=
        MAX_RETAINED_GENERATED_CONTENT_BYTES
    );
    assert.doesNotThrow(() =>
      Buffer.from(retained.rawResponse, "utf8").toString("utf8")
    );
    assert.equal(
      retained.rawResponseOriginalBytes,
      Buffer.byteLength(generated, "utf8")
    );
  });
});

function errorCode(value: unknown) {
  return typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string"
    ? value.code
    : null;
}
