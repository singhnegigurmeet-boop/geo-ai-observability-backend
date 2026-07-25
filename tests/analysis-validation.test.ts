import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplicationError } from "../src/errors/application-error.js";
import {
  createAnalysisRequestSchema,
  parseIdempotencyKey
} from "../src/analysis/analysis.schemas.js";

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

  it("accepts only the bounded Phase 8 mock preference fields", () => {
    assert.equal(
      createAnalysisRequestSchema.safeParse({
        domain: "example.com",
        preferredProvider: "mock",
        preferredModel: "mock-quality"
      }).success,
      true
    );
    for (const preferred of [
      { preferredProvider: "openai" },
      { preferredModel: "gpt-4o-mini" },
      { preferredModel: "arbitrary" }
    ]) {
      assert.equal(
        createAnalysisRequestSchema.safeParse({
          domain: "example.com",
          ...preferred
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
