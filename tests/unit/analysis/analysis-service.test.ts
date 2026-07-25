import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ownerScopedIdempotencyKey } from "../../../src/modules/analysis/services/analysis.service.js";
import type { OwnershipContext } from "../../../src/common/ownership/ownership-context.types.js";

describe("analysis service ownership keys", () => {
  it("namespaces anonymous idempotency by anonymous session", () => {
    const owner: OwnershipContext = {
      actorType: "anonymous",
      anonymousSessionId: "11",
      userId: null,
      workspaceId: null
    };
    assert.equal(
      ownerScopedIdempotencyKey(owner, "request"),
      "anonymous:11:request"
    );
  });

  it("namespaces user idempotency by user and workspace", () => {
    const owner: OwnershipContext = {
      actorType: "user",
      anonymousSessionId: null,
      userId: "21",
      workspaceId: "31",
      workspaceRole: "owner"
    };
    assert.equal(
      ownerScopedIdempotencyKey(owner, "request"),
      "user:21:31:request"
    );
  });
});
