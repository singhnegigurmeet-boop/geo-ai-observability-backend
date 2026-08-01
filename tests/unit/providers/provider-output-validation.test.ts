import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_RETAINED_GENERATED_CONTENT_BYTES,
  retainGeneratedContent,
  validateDiscoveryOutput,
  validateProviderOutput
} from "../../../src/modules/providers/services/provider-output-validation.service.js";
import type { EntityPathContext } from "../../../src/modules/prompts/contracts/entity-path-context.contract.js";
import type { JsonValue } from "../../../src/common/types/database.types.js";

const domainContext: EntityPathContext = {
  domain: { id: "1", name: "example.com" },
  startingLevel: "domain",
  targetLevel: "domain",
  canonicalPath: "example.com"
};

describe("provider output validation boundary", () => {
  it("rejects malformed JSON before contract validation", () => {
    const result = validateProviderOutput({
      generatedContent: "{not-json",
      promptType: "visibility",
      promptDepth: "weak",
      responseContractVersion: "visibility-response-v1",
      ...contextValidation(domainContext)
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
      ...contextValidation(domainContext)
    });
    assert.equal(result.valid, true);
  });

  for (const [name, mutate, code] of [
    [
      "wrong domain ID",
      (value: EntityPathContext) => ({
        ...value,
        domain: { ...value.domain, id: "99" }
      }),
      "ENTITY_PATH_DOMAIN_MISMATCH"
    ],
    [
      "wrong domain name",
      (value: EntityPathContext) => ({
        ...value,
        domain: { ...value.domain, name: "changed.example" }
      }),
      "ENTITY_PATH_DOMAIN_MISMATCH"
    ],
    [
      "wrong starting level",
      (value: EntityPathContext) => ({
        ...brandContext(value),
        startingLevel: "category" as const
      }),
      "ENTITY_PATH_STARTING_LEVEL_MISMATCH"
    ],
    [
      "wrong canonical path",
      (value: EntityPathContext) => ({
        ...value,
        canonicalPath: "different"
      }),
      "ENTITY_PATH_CANONICAL_PATH_MISMATCH"
    ]
  ] as const) {
    it(`rejects a valid response with ${name}`, () => {
      const authoritative =
        name === "wrong starting level"
          ? brandContext(domainContext)
          : domainContext;
      const frozen = mutate(authoritative);
      const result = validateProviderOutput({
        generatedContent: visibilityResponse(),
        promptType: "visibility",
        promptDepth: "weak",
        responseContractVersion: "visibility-response-v1",
        ...contextValidation(frozen, authoritative)
      });
      assert.equal(result.valid, false);
      assert.equal(errorCode(result.validationErrors[0]), code);
    });
  }

  it("rejects malformed frozen EntityPathContext", () => {
    const frozen = { ...domainContext, domain: { id: "0", name: "" } };
    const result = validateProviderOutput({
      generatedContent: visibilityResponse(),
      promptType: "visibility",
      promptDepth: "weak",
      responseContractVersion: "visibility-response-v1",
      ...contextValidation(frozen, domainContext)
    });
    assert.equal(result.valid, false);
    assert.equal(
      errorCode(result.validationErrors[0]),
      "ENTITY_PATH_CONTEXT_SCHEMA_INVALID"
    );
  });

  for (const [label, key, code] of [
    ["category", "category", "ENTITY_PATH_CATEGORY_MISMATCH"],
    ["brand", "brand", "ENTITY_PATH_BRAND_MISMATCH"],
    ["product", "product", "ENTITY_PATH_PRODUCT_MISMATCH"],
    ["use context", "useContext", "ENTITY_PATH_USE_CONTEXT_MISMATCH"]
  ] as const) {
    for (const field of ["id", "name"] as const) {
      it(`rejects a wrong ${label} ${field}`, () => {
        const authoritative = useContextPath();
        const entity = authoritative[key]!;
        const frozen = {
          ...authoritative,
          [key]: {
            ...entity,
            [field]: field === "id" ? "99" : "Changed"
          }
        };
        const result = validateProviderOutput({
          generatedContent: visibilityResponse(),
          promptType: "visibility",
          promptDepth: "weak",
          responseContractVersion: "visibility-response-v1",
          ...contextValidation(frozen, authoritative)
        });
        assert.equal(result.valid, false);
        assert.ok(validationCodes(result).includes(code));
      });
    }
  }

  it("rejects a wrong target level", () => {
    const authoritative = useContextPath();
    const frozen: EntityPathContext = {
      ...authoritative,
      useContext: undefined,
      targetLevel: "product",
      canonicalPath: "example.com > Analytics > Acme > Observer"
    };
    const result = validateProviderOutput({
      generatedContent: visibilityResponse(),
      promptType: "visibility",
      promptDepth: "weak",
      responseContractVersion: "visibility-response-v1",
      ...contextValidation(frozen, authoritative)
    });
    assert.equal(result.valid, false);
    assert.ok(
      validationCodes(result).includes("ENTITY_PATH_TARGET_LEVEL_MISMATCH")
    );
  });

  it("rejects a runtime-valid response when the hierarchy is invalid", () => {
    const result = validateProviderOutput({
      generatedContent: visibilityResponse(),
      promptType: "visibility",
      promptDepth: "weak",
      responseContractVersion: "visibility-response-v1",
      frozenContext: domainContext,
      promptInputPayload: { entityPathContext: domainContext },
      authoritativeContext: {
        valid: false,
        context: null,
        errors: [
          {
            layer: "postgres_context",
            code: "ENTITY_PATH_RELATIONSHIP_INVALID",
            message: "Invalid relationship"
          }
        ]
      }
    });
    assert.equal(result.valid, false);
    assert.equal(
      errorCode(result.validationErrors[0]),
      "ENTITY_PATH_RELATIONSHIP_INVALID"
    );
  });

  it("accepts a negative ranking result as valid evidence", () => {
    const result = validateProviderOutput({
      generatedContent: rankingResponse(false),
      promptType: "ranking",
      promptDepth: "weak",
      responseContractVersion: "ranking-response-v1",
      ...contextValidation(domainContext)
    });
    assert.equal(result.valid, true);
  });

  it("rejects a ranking target candidate that differs from backend authority", () => {
    const result = validateProviderOutput({
      generatedContent: rankingResponse(true, "Other"),
      promptType: "ranking",
      promptDepth: "weak",
      responseContractVersion: "ranking-response-v1",
      ...contextValidation(domainContext)
    });
    assert.equal(result.valid, false);
    assert.equal(
      errorCode(result.validationErrors[0]),
      "RANKING_TARGET_MISMATCH"
    );
  });

  it("rejects discovery IDs outside the active frozen candidate set", () => {
    const result = validateDiscoveryOutput({
      stage: "category",
      generatedContent: JSON.stringify({
        prompt_type: "hierarchy_discovery_category",
        contract_version: "hierarchy-discovery-category-response-v1",
        selections: [
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
      activeFrozenCandidateIds: new Set(["1", "2"]),
      maximumDiscoveredNames: 3
    });
    assert.equal(result.valid, false);
    assert.equal(
      errorCode(result.validationErrors[0]),
      "DISCOVERY_CANDIDATE_CONTEXT"
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

function contextValidation(
  frozen: JsonValue,
  authoritative: EntityPathContext = frozen as EntityPathContext
) {
  return {
    frozenContext: frozen,
    promptInputPayload: { entityPathContext: frozen },
    authoritativeContext: {
      valid: true as const,
      context: authoritative,
      promptInputPayload: { entityPathContext: frozen },
      promptType: "visibility" as const,
      promptDepth: "weak" as const,
      responseContractVersion: "visibility-response-v1"
    }
  };
}

function visibilityResponse() {
  return JSON.stringify({
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
    evidence: [],
    summary: "Bounded summary"
  });
}

function rankingResponse(found: boolean, name = "example.com") {
  return JSON.stringify({
    prompt_type: "ranking",
    contract_version: "ranking-response-v1",
    result: {
      requested_top_k: 5,
      found,
      rank_position: found ? 1 : null,
      ordered_candidates: [{ rank: 1, name: found ? name : "Other" }],
      mention_count: found ? 1 : 0,
      confidence: 0.7
    },
    evidence: [],
    summary: "Ranking summary"
  });
}

function brandContext(value: EntityPathContext): EntityPathContext {
  return {
    ...value,
    category: { id: "2", name: "Analytics" },
    brand: { id: "3", name: "Acme" },
    targetLevel: "brand",
    canonicalPath: "example.com > Analytics > Acme"
  };
}

function useContextPath(): EntityPathContext {
  return {
    ...brandContext(domainContext),
    product: { id: "4", name: "Observer" },
    useContext: { id: "5", name: "Enterprise monitoring" },
    targetLevel: "use_context",
    canonicalPath:
      "example.com > Analytics > Acme > Observer > Enterprise monitoring"
  };
}

function validationCodes(result: {
  validationErrors: readonly unknown[];
}) {
  return result.validationErrors
    .map(errorCode)
    .filter((code): code is string => code !== null);
}

function errorCode(value: unknown) {
  return typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string"
    ? value.code
    : null;
}
