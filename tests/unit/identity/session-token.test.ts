import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionTokenService } from "../../../src/modules/identity/services/session-token.service.js";

describe("session token service", () => {
  it("generates opaque 256-bit tokens and stores deterministic hashes", () => {
    const service = new SessionTokenService(
      "test-session-pepper-with-at-least-32-characters"
    );
    const first = service.generate();
    const second = service.generate();

    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(first.tokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(first.token, first.tokenHash);
    assert.notEqual(first.token, second.token);
    assert.notEqual(first.tokenHash, second.tokenHash);
    assert.equal(service.hash(first.token), first.tokenHash);
  });

  it("separates token hashes by pepper", () => {
    const first = new SessionTokenService(
      "first-session-pepper-with-at-least-32-characters"
    );
    const second = new SessionTokenService(
      "second-session-pepper-with-at-least-32-characters"
    );

    assert.notEqual(first.hash("opaque-token"), second.hash("opaque-token"));
  });
});
