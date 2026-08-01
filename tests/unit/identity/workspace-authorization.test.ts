import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplicationError } from "../../../src/common/errors/application-error.js";
import { WorkspaceAuthorizationService } from "../../../src/modules/workspaces/services/workspace-authorization.service.js";

describe("workspace authorization", () => {
  it("allows explicitly listed roles", async () => {
    const service = new WorkspaceAuthorizationService({
      async findActiveMembership() {
        return {
          workspace_id: "1",
          user_id: "2",
          role: "admin",
          joined_at: new Date(),
          updated_at: new Date()
        };
      }
    } as never);
    const membership = await service.requireMembership("2", "1");

    assert.equal(service.requireAnyRole(membership, ["owner", "admin"]), membership);
  });

  it("rejects missing membership and unlisted roles", async () => {
    const missing = new WorkspaceAuthorizationService({
      async findActiveMembership() {
        return null;
      }
    } as never);
    await assert.rejects(
      missing.requireMembership("2", "1"),
      hasCategory("FORBIDDEN")
    );

    const viewer = {
      workspace_id: "1",
      user_id: "2",
      role: "viewer" as const,
      joined_at: new Date(),
      updated_at: new Date()
    };
    assert.throws(
      () => missing.requireAnyRole(viewer, ["owner", "admin"]),
      hasCategory("FORBIDDEN")
    );
  });

  it("centralizes mutation authorization for owner, admin, and member only", () => {
    const service = new WorkspaceAuthorizationService({} as never);
    const membership = (role: "owner" | "admin" | "member" | "viewer") => ({
      workspace_id: "1", user_id: "2", role,
      joined_at: new Date(), updated_at: new Date()
    });

    for (const role of ["owner", "admin", "member"] as const) {
      assert.equal(service.requireMutationRole(membership(role)).role, role);
    }
    assert.throws(
      () => service.requireMutationRole(membership("viewer")),
      hasCategory("FORBIDDEN")
    );
  });
});

function hasCategory(category: ApplicationError["category"]) {
  return (error: unknown) => {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.category, category);
    return true;
  };
}
