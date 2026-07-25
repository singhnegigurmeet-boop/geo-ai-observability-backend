import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import express from "express";
import { errorMiddleware } from "../../../src/common/middleware/error.middleware.js";
import { createOwnershipContextMiddleware } from "../../../src/common/ownership/ownership-context.middleware.js";
import type { OwnershipCredentials } from "../../../src/common/ownership/ownership-context.types.js";

describe("ownership middleware", () => {
  let server: Server;
  let baseUrl: string;
  let received: OwnershipCredentials | null = null;

  before(async () => {
    const app = express();
    app.get(
      "/protected",
      createOwnershipContextMiddleware({
        async resolve(credentials) {
          received = credentials;
          return {
            actorType: "user",
            anonymousSessionId: null,
            userId: "10",
            workspaceId: "20",
            workspaceRole: "owner"
          };
        }
      }),
      (request, response) => {
        response.json(request.ownershipContext);
      }
    );
    app.use(errorMiddleware);

    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("extracts credentials and attaches the resolved context", async () => {
    const response = await fetch(`${baseUrl}/protected`, {
      headers: {
        authorization: "Bearer user_token",
        "x-workspace-id": "20",
        "x-anonymous-session-token": "anonymous_token"
      }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(received, {
      userSessionToken: "user_token",
      anonymousSessionToken: "anonymous_token",
      workspaceId: "20"
    });
    assert.equal((await response.json() as { actorType: string }).actorType, "user");
  });

  it("rejects malformed credentials before resolution", async () => {
    received = null;
    const response = await fetch(`${baseUrl}/protected`, {
      headers: { authorization: "Basic secret" }
    });
    const body = await response.json() as {
      details: { category: string };
    };

    assert.equal(response.status, 401);
    assert.equal(body.details.category, "UNAUTHENTICATED");
    assert.equal(received, null);
  });
});
