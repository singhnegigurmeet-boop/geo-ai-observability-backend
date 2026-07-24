import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplicationError } from "../src/errors/application-error.js";
import { assertSessionUsable } from "../src/identity/session-state.js";

function assertCategory(
  callback: () => void,
  category: ApplicationError["category"]
) {
  assert.throws(
    callback,
    (error) =>
      error instanceof ApplicationError && error.category === category
  );
}

describe("session state validation", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const future = new Date("2026-01-01T01:00:00.000Z");

  it("accepts an active unexpired session", () => {
    assert.doesNotThrow(() => assertSessionUsable("active", future, now));
  });

  it("uses stable categories for revoked and expired sessions", () => {
    assertCategory(
      () => assertSessionUsable("revoked", future, now),
      "REVOKED_SESSION"
    );
    assertCategory(
      () => assertSessionUsable("expired", future, now),
      "EXPIRED_SESSION"
    );
    assertCategory(
      () => assertSessionUsable("active", now, now),
      "EXPIRED_SESSION"
    );
  });
});
