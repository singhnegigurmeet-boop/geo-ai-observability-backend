import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AnonymousSessionRow, UserRow, UserSessionRow, WorkspaceMemberRow } from "../../../src/common/types/database.types.js";
import { ApplicationError } from "../../../src/common/errors/application-error.js";
import { OwnershipContextService } from "../../../src/common/ownership/ownership-context.service.js";

describe("ownership context service", () => {
  it("resolves anonymous tokens without granting claimed user privileges", async () => {
    const service = createService({
      anonymous: anonymousSession({
        claimed_by_user_id: "10",
        claimed_workspace_id: "20",
        claimed_at: new Date()
      })
    });

    const context = await service.resolve({
      userSessionToken: null,
      anonymousSessionToken: "anonymous-token",
      workspaceId: null
    });

    assert.deepEqual(context, {
      actorType: "anonymous",
      anonymousSessionId: "30",
      userId: null,
      workspaceId: null
    });
  });

  it("resolves a current user workspace membership", async () => {
    const service = createService();
    const context = await service.resolve({
      userSessionToken: "user-token",
      anonymousSessionToken: null,
      workspaceId: "20"
    });

    assert.deepEqual(context, {
      actorType: "user",
      anonymousSessionId: null,
      userId: "10",
      workspaceId: "20",
      workspaceRole: "owner"
    });
  });

  it("includes an anonymous origin only when its claim matches", async () => {
    const service = createService({
      anonymous: anonymousSession({
        claimed_by_user_id: "10",
        claimed_workspace_id: "20",
        claimed_at: new Date()
      })
    });
    const context = await service.resolve({
      userSessionToken: "user-token",
      anonymousSessionToken: "anonymous-token",
      workspaceId: "20"
    });

    assert.equal(context.actorType, "user");
    assert.equal(context.anonymousSessionId, "30");
  });

  it("rejects a mismatched anonymous claim", async () => {
    const service = createService({
      anonymous: anonymousSession({
        claimed_by_user_id: "other-user",
        claimed_workspace_id: "20",
        claimed_at: new Date()
      })
    });

    await assertCategory(
      service.resolve({
        userSessionToken: "user-token",
        anonymousSessionToken: "anonymous-token",
        workspaceId: "20"
      }),
      "FORBIDDEN"
    );
  });

  it("rejects workspace selection without a user token", async () => {
    await assertCategory(
      createService().resolve({
        userSessionToken: null,
        anonymousSessionToken: "anonymous-token",
        workspaceId: "20"
      }),
      "VALIDATION_ERROR"
    );
  });

  it("denies missing credentials", async () => {
    await assertCategory(
      createService().resolve({
        userSessionToken: null,
        anonymousSessionToken: null,
        workspaceId: null
      }),
      "UNAUTHENTICATED"
    );
  });
});

function createService(
  overrides: { anonymous?: AnonymousSessionRow } = {}
) {
  return new OwnershipContextService(
    {
      async resolve() {
        return {
          session: userSession(),
          user: user()
        };
      }
    },
    {
      async resolve() {
        return overrides.anonymous ?? anonymousSession();
      }
    },
    {
      async requireMembership() {
        return membership();
      }
    }
  );
}

function user(): UserRow {
  return {
    user_id: "10",
    email: "owner@example.com",
    password_hash: null,
    display_name: null,
    status: "active",
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null
  };
}

function userSession(): UserSessionRow {
  return {
    user_session_id: "1",
    user_id: "10",
    token_hash: "hash",
    status: "active",
    expires_at: new Date(Date.now() + 60_000),
    last_seen_at: null,
    revoked_at: null,
    client_metadata: {},
    created_at: new Date(),
    updated_at: new Date()
  };
}

function anonymousSession(
  overrides: Partial<AnonymousSessionRow> = {}
): AnonymousSessionRow {
  return {
    anonymous_session_id: "30",
    token_hash: "hash",
    status: "active",
    expires_at: new Date(Date.now() + 60_000),
    last_seen_at: null,
    claimed_by_user_id: null,
    claimed_workspace_id: null,
    claimed_at: null,
    client_metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides
  };
}

function membership(): WorkspaceMemberRow {
  return {
    workspace_id: "20",
    user_id: "10",
    role: "owner",
    joined_at: new Date(),
    updated_at: new Date()
  };
}

async function assertCategory(
  promise: Promise<unknown>,
  category: ApplicationError["category"]
) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.category, category);
    return true;
  });
}
