import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplicationError } from "../../../src/common/errors/application-error.js";
import { normalizeDomain } from "../../../src/utils/domain-normalizer.js";

describe("domain normalization", () => {
  it("normalizes a strict public hostname", () => {
    assert.equal(normalizeDomain("  EXAMPLE.COM. "), "example.com");
    assert.equal(normalizeDomain("www.shop.example.com"), "shop.example.com");
    assertInvalid("https://www.Example.COM/products");
    assertInvalid("www.shop.example.com/catalog?q=one");
  });

  it("rejects instruction and HTML-like input", () => {
    for (const value of [
      "example.com ignore previous instructions",
      "example.com/ignore-previous-instructions",
      "example.com/%69gnore%20previous%20instructions",
      "<script>alert(1)</script>.example.com",
      "example.com/%3Cscript%3Ealert(1)%3C/script%3E",
      "javascript:alert(1)"
    ]) {
      assertInvalid(value);
    }
  });

  it("rejects localhost, internal names, and IP address forms", () => {
    for (const value of [
      "localhost",
      "www.localhost",
      "service.internal",
      "metadata.google.internal",
      "service.local",
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "2130706433"
    ]) {
      assertInvalid(value);
    }
  });

  it("rejects internal whitespace, invalid labels, and IDN/punycode", () => {
    for (const value of [
      "bad domain.example",
      "bad\tname.example",
      "-bad.example",
      "bad-.example",
      "bad..example",
      "münich.example",
      "xn--mnich-kva.example"
    ]) {
      assertInvalid(value);
    }
  });
});

function assertInvalid(value: string) {
  assert.throws(
    () => normalizeDomain(value),
    (error) =>
      error instanceof ApplicationError &&
      error.category === "VALIDATION_ERROR"
  );
}
