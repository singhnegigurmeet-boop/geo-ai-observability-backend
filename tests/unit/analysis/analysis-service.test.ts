import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnalysisService, ownerScopedIdempotencyKey } from "../../../src/modules/analysis/services/analysis.service.js";
import { ApplicationError } from "../../../src/common/errors/application-error.js";
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

  it("rejects viewer create and cancel before touching the database", async () => {
    let queries = 0;
    const database = {
      async query() { queries += 1; throw new Error("database must not be touched"); },
      async connect() { queries += 1; throw new Error("database must not be touched"); }
    } as never;
    const service = new AnalysisService(database);
    const viewer: OwnershipContext = {
      actorType: "user", anonymousSessionId: null, userId: "21",
      workspaceId: "31", workspaceRole: "viewer"
    };
    const forbidden = (error: unknown) =>
      error instanceof ApplicationError && error.category === "FORBIDDEN";

    await assert.rejects(
      service.create({ domain: "example.com", promptDepth: "medium" }, "key", viewer),
      forbidden
    );
    await assert.rejects(service.cancel("41", viewer), forbidden);
    await assert.rejects(
      service.continueHierarchy({ domain: "example.com" }, "nav", viewer),
      forbidden
    );
    assert.equal(queries, 0);
  });

  it("rejects anonymous product and use-context analysis and brand continuation before side effects", async () => {
    let touches = 0;
    const database = {
      async query() { touches += 1; throw new Error("database must not be touched"); },
      async connect() { touches += 1; throw new Error("database must not be touched"); }
    } as never;
    const service = new AnalysisService(database);
    const anonymous: OwnershipContext = {
      actorType: "anonymous",
      anonymousSessionId: "11",
      userId: null,
      workspaceId: null
    };
    const forbidden = (error: unknown) =>
      error instanceof ApplicationError && error.category === "FORBIDDEN";
    const product = { domain: "example.com", categoryId: "1", brandId: "2", productId: "3" };
    const context = { ...product, useContextId: "4" };

    await assert.rejects(service.create(product, "product", anonymous), forbidden);
    await assert.rejects(service.preview(context, anonymous), forbidden);
    await assert.rejects(
      service.continueHierarchy({ domain: "example.com", categoryId: "1", brandId: "2" }, "deeper", anonymous),
      forbidden
    );
    assert.equal(touches, 0);
  });
});
