import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplicationError } from "../src/errors/application-error.js";
import { normalizeDomain } from "../src/hierarchy/domain-normalizer.js";

describe("domain normalization", () => {
  it("normalizes case, surrounding whitespace, trailing dot, and IDNs", () => {
    assert.equal(normalizeDomain("  EXAMPLE.COM. "), "example.com");
    assert.equal(normalizeDomain("münich.example"), "xn--mnich-kva.example");
  });

  it("rejects URLs, ports, gaps, and invalid labels", () => {
    for (const value of [
      "",
      "https://example.com",
      "example.com/path",
      "example.com:443",
      "bad domain.example",
      "-bad.example",
      "bad-.example",
      "bad..example"
    ]) {
      assert.throws(
        () => normalizeDomain(value),
        (error) =>
          error instanceof ApplicationError &&
          error.category === "VALIDATION_ERROR"
      );
    }
  });
});
