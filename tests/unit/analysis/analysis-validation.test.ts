import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplicationError } from "../../../src/common/errors/application-error.js";
import {
  createAnalysisRequestSchema,
  hierarchyNavigationRequestSchema,
  parseIdempotencyKey
} from "../../../src/modules/analysis/schemas/analysis.schemas.js";

describe("analysis submission validation", () => {
  it("accepts each contiguous hierarchy shape", () => {
    for (const body of [
      { domain: "example.com" },
      { domain: "example.com", categoryId: "1" },
      { domain: "example.com", categoryId: "1", brandId: "2" },
      {
        domain: "example.com",
        categoryId: "1",
        brandId: "2",
        productId: "3"
      },
      {
        domain: "example.com",
        categoryId: "1",
        brandId: "2",
        productId: "3",
        useContextId: "4"
      }
    ]) {
      assert.equal(createAnalysisRequestSchema.safeParse(body).success, true);
    }
  });

  it("rejects hierarchy gaps", () => {
    for (const body of [
      { domain: "example.com", brandId: "2" },
      { domain: "example.com", categoryId: "1", productId: "3" },
      {
        domain: "example.com",
        categoryId: "1",
        brandId: "2",
        useContextId: "4"
      }
    ]) {
      assert.equal(createAnalysisRequestSchema.safeParse(body).success, false);
    }
  });

  it("accepts one complete navigation parent and rejects gaps", () => {
    for (const body of [
      { domain: "example.com" },
      { domain: "example.com", categoryId: "1" },
      { domain: "example.com", categoryId: "1", brandId: "2" },
      { domain: "example.com", categoryId: "1", brandId: "2", productId: "3" }
    ]) {
      assert.equal(hierarchyNavigationRequestSchema.safeParse(body).success, true);
    }
    assert.equal(
      hierarchyNavigationRequestSchema.safeParse({ domain: "example.com", brandId: "2" }).success,
      false
    );
  });

  it("accepts only the bounded final providerModels contract", () => {
    assert.equal(
      createAnalysisRequestSchema.safeParse({
        domain: "example.com",
        providerModels: [{ provider: "mock", model: "mock-quality" }]
      }).success,
      true
    );
    assert.equal(
      createAnalysisRequestSchema.safeParse({
        domain: "example.com",
        providerModels: [{ provider: "openai", model: "gpt-4o-mini" }]
      }).success,
      true
    );
    for (const invalid of [
      { providerModels: [] },
      { providerModels: [{ provider: "openai" }] },
      {
        categorySelection: {
          mode: "selected",
          categoryIds: ["1", "1"]
        }
      }
    ]) {
      assert.equal(
        createAnalysisRequestSchema.safeParse({
          domain: "example.com",
          ...invalid
        }).success,
        false
      );
    }
  });

  it("requires one bounded Idempotency-Key value", () => {
    assert.equal(parseIdempotencyKey(" request-1 "), "request-1");
    assert.throws(
      () => parseIdempotencyKey(undefined),
      hasCategory("VALIDATION_ERROR")
    );
    assert.throws(
      () => parseIdempotencyKey("a,b"),
      hasCategory("VALIDATION_ERROR")
    );
  });
});

function hasCategory(category: ApplicationError["category"]) {
  return (error: unknown) =>
    error instanceof ApplicationError && error.category === category;
}
