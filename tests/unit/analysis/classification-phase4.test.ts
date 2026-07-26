import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  DomainCategoryClassificationJobRow,
  JsonObject
} from "../../../src/common/types/database.types.js";
import {
  authoritativeClassificationContext,
  ClassificationIntegrityError,
  type AuthoritativeRequestedCategory
} from "../../../src/modules/analysis/services/classification-authority.service.js";
import {
  canonicalClassificationExecutionIdentity,
  classificationCandidateSetHash,
  classificationExecutionHash,
  classificationIdempotencyKey,
  type ClassificationExecutionIdentity
} from "../../../src/modules/analysis/services/classification-execution-identity.service.js";
import {
  classificationRelationshipAction
} from "../../../src/modules/analysis/services/classification-relationship-policy.service.js";
import {
  renderClassificationPrompt
} from "../../../src/modules/analysis/services/classification-planning.service.js";
import {
  validateFrozenClassificationModel
} from "../../../src/modules/providers/policies/provider-model.policy.js";

const candidates = [
  { categoryId: "10", categoryName: "Analytics" },
  { categoryId: "20", categoryName: "Monitoring" }
] as const;

const requested: AuthoritativeRequestedCategory[] = candidates.map(
  (category, ordinal) => ({
    ...category,
    ordinal,
    isActive: true
  })
);

const identity: ClassificationExecutionIdentity = {
  analysisRunId: "100",
  domainId: "200",
  candidateSetHash: classificationCandidateSetHash(
    candidates.map((candidate) => candidate.categoryId)
  ),
  classifierProvider: "mock",
  classifierModel: "mock-fast",
  modelProfileVersion: "mock-fast-profile-v1",
  promptVersion: "domain-category-classification-v1",
  responseContractVersion: "domain-category-classification-response-v1",
  providerInstructionProfile: "mock-json-schema-v1",
  structuredOutputMode: "json_schema"
};

describe("Phase 4 classification execution identity", () => {
  it("produces identical keys for an identical complete identity", () => {
    assert.equal(
      classificationIdempotencyKey(identity),
      classificationIdempotencyKey({ ...identity })
    );
    assert.equal(
      classificationExecutionHash(identity),
      classificationExecutionHash({ ...identity })
    );
  });

  for (const [label, field, value] of [
    ["provider", "classifierProvider", "openai"],
    ["model", "classifierModel", "mock-standard"],
    ["model profile", "modelProfileVersion", "profile-v2"],
    ["prompt", "promptVersion", "classification-v2"],
    ["response contract", "responseContractVersion", "contract-v2"],
    ["instruction profile", "providerInstructionProfile", "instruction-v2"],
    ["structured output", "structuredOutputMode", "json_mode"],
    ["candidate set", "candidateSetHash", "f".repeat(64)]
  ] as const) {
    it(`${label} changes the execution identity`, () => {
      assert.notEqual(
        classificationExecutionHash(identity),
        classificationExecutionHash({ ...identity, [field]: value })
      );
    });
  }

  it("uses a fixed canonical field order and deterministic candidate order", () => {
    assert.equal(
      canonicalClassificationExecutionIdentity(identity),
      canonicalClassificationExecutionIdentity({
        structuredOutputMode: identity.structuredOutputMode,
        providerInstructionProfile: identity.providerInstructionProfile,
        responseContractVersion: identity.responseContractVersion,
        promptVersion: identity.promptVersion,
        modelProfileVersion: identity.modelProfileVersion,
        classifierModel: identity.classifierModel,
        classifierProvider: identity.classifierProvider,
        candidateSetHash: identity.candidateSetHash,
        domainId: identity.domainId,
        analysisRunId: identity.analysisRunId
      })
    );
    assert.equal(
      classificationCandidateSetHash(["10", "20"]),
      classificationCandidateSetHash(["10", "20"])
    );
    assert.notEqual(
      classificationCandidateSetHash(["10", "20"]),
      classificationCandidateSetHash(["20", "10"])
    );
  });
});

describe("authoritative classification planning input", () => {
  it("renders the prompt from ordered relational category rows", () => {
    const authority = authoritativeClassificationContext(authorityInput());
    const prompt = renderClassificationPrompt({
      normalizedDomain: "example.com",
      candidates: authority.candidates,
      promptVersion: identity.promptVersion,
      responseContractVersion: identity.responseContractVersion
    });
    assert.ok(prompt.includes("Website hostname: example.com"));
    assert.ok(prompt.includes("1. id=10; name=Analytics"));
    assert.ok(prompt.includes("2. id=20; name=Monitoring"));
    assert.ok(
      prompt.indexOf("id=10") < prompt.indexOf("id=20")
    );
    assert.ok(prompt.includes("Return zero matches"));
    assert.ok(prompt.includes("no markdown or extra keys"));
  });

  it("rejects tampered JSON instead of allowing it to override authority", () => {
    const input = authorityInput();
    input.job.input_payload = {
      domain: { id: "200", name: "evil.example" },
      candidates: candidates.map((candidate) => ({ ...candidate }))
    };
    assertIntegrity(
      () => authoritativeClassificationContext(input),
      "CLASSIFICATION_INPUT_SNAPSHOT_MISMATCH"
    );
  });

  it("rejects a missing authoritative domain", () => {
    assertIntegrity(
      () =>
        authoritativeClassificationContext({
          ...authorityInput(),
          normalizedDomain: null
        }),
      "CLASSIFICATION_DOMAIN_MISSING"
    );
  });

  it("rejects a missing requested category master", () => {
    const input = authorityInput();
    input.requestedCategories[1] = {
      categoryId: "20",
      categoryName: null,
      isActive: null,
      ordinal: 1
    };
    assertIntegrity(
      () => authoritativeClassificationContext(input),
      "CLASSIFICATION_CATEGORY_MISSING"
    );
  });

  it("fails closed when a frozen requested category is inactive", () => {
    const input = authorityInput();
    input.requestedCategories[1] = {
      ...input.requestedCategories[1]!,
      isActive: false
    };
    assertIntegrity(
      () => authoritativeClassificationContext(input),
      "CLASSIFICATION_CATEGORY_INACTIVE"
    );
  });

  it("rejects candidate-count and candidate-hash mismatches", () => {
    const count = authorityInput();
    count.job.candidate_count = 3;
    assertIntegrity(
      () => authoritativeClassificationContext(count),
      "CLASSIFICATION_CANDIDATE_COUNT_MISMATCH"
    );

    const hash = authorityInput();
    hash.job.candidate_set_hash = "f".repeat(64);
    hash.job.idempotency_key = classificationIdempotencyKey({
      ...identity,
      candidateSetHash: hash.job.candidate_set_hash
    });
    assertIntegrity(
      () => authoritativeClassificationContext(hash),
      "CLASSIFICATION_CANDIDATE_HASH_MISMATCH"
    );
  });

  it("does not reorder candidates or rewrite frozen classifier fields", () => {
    const selection = validateFrozenClassificationModel({
      provider: "mock",
      model: "mock-fast",
      modelProfileVersion: "mock-fast-profile-v1",
      providerInstructionProfile: "mock-json-schema-v1",
      structuredOutputMode: "json_schema"
    });
    assert.deepEqual(
      {
        provider: selection.provider,
        model: selection.model,
        modelProfileVersion: selection.modelProfileVersion,
        providerInstructionProfile: selection.providerInstructionProfile,
        structuredOutputMode: selection.preferredStructuredOutputMode
      },
      {
        provider: "mock",
        model: "mock-fast",
        modelProfileVersion: "mock-fast-profile-v1",
        providerInstructionProfile: "mock-json-schema-v1",
        structuredOutputMode: "json_schema"
      }
    );
    assert.throws(
      () =>
        validateFrozenClassificationModel({
          provider: "mock",
          model: "mock-fast",
          modelProfileVersion: "mock-fast-profile-v1",
          providerInstructionProfile: "old-instruction-profile",
          structuredOutputMode: "json_schema"
        }),
      /instruction profile/
    );
  });
});

describe("classification relationship policy", () => {
  it("creates a missing relationship", () => {
    assert.equal(classificationRelationshipAction(null), "create");
  });

  for (const source of ["manual", "import", "llm_classification"] as const) {
    it(`reuses an active ${source} relationship without a provenance rewrite`, () => {
      assert.equal(
        classificationRelationshipAction({ isActive: true, source }),
        "reuse"
      );
    });
  }

  it("reactivates an inactive relationship", () => {
    assert.equal(
      classificationRelationshipAction({
        isActive: false,
        source: "manual"
      }),
      "reactivate"
    );
  });
});

function authorityInput() {
  return {
    job: classificationJob(),
    runDomainId: "200",
    normalizedDomain: "example.com",
    domainActive: true,
    requestedCategories: requested.map((category) => ({ ...category }))
  };
}

function classificationJob(): DomainCategoryClassificationJobRow {
  const now = new Date();
  const inputPayload = {
    domain: { id: "200", name: "example.com" },
    candidates: candidates.map((candidate) => ({ ...candidate }))
  } satisfies JsonObject;
  return {
    domain_category_classification_job_id: "300",
    idempotency_key: classificationIdempotencyKey(identity),
    analysis_run_id: identity.analysisRunId,
    domain_id: identity.domainId,
    candidate_set_hash: identity.candidateSetHash,
    status: "queued",
    classifier_provider: identity.classifierProvider,
    classifier_model: identity.classifierModel,
    model_profile_version: identity.modelProfileVersion,
    prompt_version: identity.promptVersion,
    response_contract_version: identity.responseContractVersion,
    provider_instruction_profile: identity.providerInstructionProfile,
    structured_output_mode: identity.structuredOutputMode,
    input_payload: inputPayload,
    rendered_prompt: null,
    candidate_count: 2,
    error_code: null,
    error_message: null,
    started_at: null,
    completed_at: null,
    created_at: now,
    updated_at: now
  };
}

function assertIntegrity(operation: () => unknown, code: string) {
  assert.throws(
    operation,
    (error) =>
      error instanceof ClassificationIntegrityError &&
      error.code === code
  );
}
