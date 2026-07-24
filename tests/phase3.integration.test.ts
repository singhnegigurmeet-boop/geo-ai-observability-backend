import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../src/db/migration-runner.js";
import { ApplicationError } from "../src/errors/application-error.js";
import { AnonymousSessionRepository } from "../src/identity/anonymous-session.repository.js";
import { AnonymousSessionService } from "../src/identity/anonymous-session.service.js";
import { SessionTokenService } from "../src/identity/session-token.service.js";
import { UserProvisioningService } from "../src/identity/user-provisioning.service.js";
import { UserRepository } from "../src/identity/user.repository.js";
import { UserSessionRepository } from "../src/identity/user-session.repository.js";
import { UserSessionService } from "../src/identity/user-session.service.js";
import { OwnershipContextService } from "../src/ownership/ownership-context.service.js";
import { WorkspaceAuthorizationService } from "../src/workspaces/workspace-authorization.service.js";
import { WorkspaceMemberRepository } from "../src/workspaces/workspace-member.repository.js";
import { WorkspaceRoleChangeRequestRepository } from "../src/workspaces/workspace-role-change-request.repository.js";

const runIntegrationTests =
  process.env.RUN_PHASE3_INTEGRATION_TESTS === "true";
const pepper = "phase-3-integration-pepper-with-at-least-32-characters";

describe(
  "Phase 3 identity and workspace integration",
  { skip: !runIntegrationTests },
  () => {
    let pool: pg.Pool;
    let tokens: SessionTokenService;
    let provisioning: UserProvisioningService;

    before(async () => {
      const databaseUrl =
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test";
      pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });

      const database = await pool.query<{ database_name: string }>(
        "SELECT current_database() AS database_name"
      );
      const databaseName = database.rows[0]?.database_name;
      if (!databaseName?.endsWith("_test")) {
        throw new Error(
          `Refusing to reset Phase 3 database without _test suffix: ${
            databaseName ?? "unknown"
          }`
        );
      }

      await pool.query("DROP SCHEMA IF EXISTS geo_meta CASCADE");
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await runMigrations({
        pool,
        migrationsDirectory: getDefaultMigrationsDirectory()
      });

      tokens = new SessionTokenService(pepper);
      provisioning = new UserProvisioningService(pool);
    });

    after(async () => {
      await pool?.end();
    });

    it("creates and resolves anonymous sessions without storing raw tokens", async () => {
      const service = createAnonymousService(pool, tokens);
      const created = await service.create({
        clientMetadata: { userAgent: "integration-test" }
      });

      assert.notEqual(created.token, created.session.token_hash);
      assert.equal(created.session.token_hash, tokens.hash(created.token));
      assert.equal(created.session.client_metadata.userAgent, "integration-test");

      const resolved = await service.resolve(created.token);
      assert.equal(
        resolved.anonymous_session_id,
        created.session.anonymous_session_id
      );
      const stored = await new AnonymousSessionRepository(pool).findByTokenHash(
        created.session.token_hash
      );
      assert.ok(stored?.last_seen_at);
    });

    it("creates a user, default workspace, and owner membership atomically", async () => {
      const result = await provisioning.createUserWithDefaultWorkspace({
        email: "  OWNER@Example.com ",
        displayName: "Owner",
        defaultWorkspaceName: "Primary Workspace"
      });

      assert.equal(result.user.email, "owner@example.com");
      assert.equal(result.workspace.created_by_user_id, result.user.user_id);
      assert.equal(result.membership.workspace_id, result.workspace.workspace_id);
      assert.equal(result.membership.user_id, result.user.user_id);
      assert.equal(result.membership.role, "owner");

      await assertCategory(
        provisioning.createUserWithDefaultWorkspace({
          email: "owner@example.com",
          defaultWorkspaceName: "Must Roll Back"
        }),
        "CONFLICT"
      );
      const rolledBack = await pool.query<{ count: string }>(
        "SELECT count(*) FROM workspaces WHERE workspace_name = 'Must Roll Back'"
      );
      assert.equal(rolledBack.rows[0]?.count, "0");
    });

    it("creates and resolves user sessions by opaque token", async () => {
      const provisioned = await provisionUser(
        provisioning,
        "session-user@example.com",
        "Session Workspace"
      );
      const service = createUserSessionService(pool, tokens);
      const created = await service.create(provisioned.user.user_id, {
        device: "test"
      });

      assert.notEqual(created.token, created.session.token_hash);
      assert.equal(created.session.token_hash, tokens.hash(created.token));

      const identity = await service.resolve(created.token);
      assert.equal(identity.user.user_id, provisioned.user.user_id);
      assert.equal(identity.session.user_session_id, created.session.user_session_id);
      assert.ok(
        (
          await new UserSessionRepository(pool).findIdentityByTokenHash(
            created.session.token_hash
          )
        )?.session.last_seen_at
      );

      await new UserSessionRepository(pool).revoke(
        created.session.user_session_id,
        new Date()
      );
      await assertCategory(service.resolve(created.token), "REVOKED_SESSION");
    });

    it("enforces current membership and explicit workspace roles", async () => {
      const first = await provisionUser(
        provisioning,
        "member-a@example.com",
        "Workspace A"
      );
      const second = await provisionUser(
        provisioning,
        "member-b@example.com",
        "Workspace B"
      );
      const members = new WorkspaceMemberRepository(pool);
      const authorization = new WorkspaceAuthorizationService(members);

      const ownerMembership = await authorization.requireMembership(
        first.user.user_id,
        first.workspace.workspace_id
      );
      assert.equal(ownerMembership.role, "owner");
      authorization.requireAnyRole(ownerMembership, ["owner", "admin"]);

      await assertCategory(
        authorization.requireMembership(
          first.user.user_id,
          second.workspace.workspace_id
        ),
        "FORBIDDEN"
      );

      const viewer = await members.add(
        first.user.user_id,
        second.workspace.workspace_id,
        "viewer"
      );
      assert.throws(
        () => authorization.requireAnyRole(viewer, ["owner", "admin"]),
        hasCategory("FORBIDDEN")
      );
    });

    it("creates and reviews workspace role-change requests through memberships", async () => {
      const owner = await provisionUser(
        provisioning,
        "role-owner@example.com",
        "Role Workspace"
      );
      const target = await provisionUser(
        provisioning,
        "role-target@example.com",
        "Target Workspace"
      );
      const members = new WorkspaceMemberRepository(pool);
      await members.add(
        target.user.user_id,
        owner.workspace.workspace_id,
        "viewer"
      );
      const requests = new WorkspaceRoleChangeRequestRepository(pool);
      const request = await requests.create({
        workspaceId: owner.workspace.workspace_id,
        targetUserId: target.user.user_id,
        requestedRole: "member",
        requestedByUserId: owner.user.user_id,
        requestReason: "Expanded duties"
      });

      assert.equal(
        (await requests.findPending(owner.workspace.workspace_id)).length,
        1
      );
      const reviewed = await requests.review(
        request.workspace_role_change_request_id,
        owner.user.user_id,
        "approved",
        "Approved",
        new Date()
      );
      assert.equal(reviewed?.status, "approved");
    });

    it("claims anonymous sessions idempotently for a real workspace member", async () => {
      const owner = await provisionUser(
        provisioning,
        "claim-owner@example.com",
        "Claim Workspace"
      );
      const anonymous = createAnonymousService(pool, tokens);
      const created = await anonymous.create();
      const input = {
        anonymousSessionId: created.session.anonymous_session_id,
        userId: owner.user.user_id,
        workspaceId: owner.workspace.workspace_id
      };

      const firstClaim = await anonymous.claim(input);
      const secondClaim = await anonymous.claim(input);

      assert.equal(
        firstClaim.anonymous_session_id,
        created.session.anonymous_session_id
      );
      assert.equal(firstClaim.claimed_by_user_id, owner.user.user_id);
      assert.equal(
        firstClaim.claimed_workspace_id,
        owner.workspace.workspace_id
      );
      assert.equal(
        secondClaim.claimed_at?.toISOString(),
        firstClaim.claimed_at?.toISOString()
      );
    });

    it("rejects claims without membership and claims owned by someone else", async () => {
      const first = await provisionUser(
        provisioning,
        "claim-first@example.com",
        "First Claim Workspace"
      );
      const second = await provisionUser(
        provisioning,
        "claim-second@example.com",
        "Second Claim Workspace"
      );
      const anonymous = createAnonymousService(pool, tokens);
      const invalidMembership = await anonymous.create();

      await assertCategory(
        anonymous.claim({
          anonymousSessionId: invalidMembership.session.anonymous_session_id,
          userId: first.user.user_id,
          workspaceId: second.workspace.workspace_id
        }),
        "FORBIDDEN"
      );
      const unclaimed = await new AnonymousSessionRepository(pool).findByTokenHash(
        invalidMembership.session.token_hash
      );
      assert.equal(unclaimed?.claimed_by_user_id, null);

      const claimed = await anonymous.create();
      await anonymous.claim({
        anonymousSessionId: claimed.session.anonymous_session_id,
        userId: first.user.user_id,
        workspaceId: first.workspace.workspace_id
      });
      await new WorkspaceMemberRepository(pool).add(
        second.user.user_id,
        first.workspace.workspace_id,
        "member"
      );
      await assertCategory(
        anonymous.claim({
          anonymousSessionId: claimed.session.anonymous_session_id,
          userId: second.user.user_id,
          workspaceId: first.workspace.workspace_id
        }),
        "CONFLICT"
      );
    });

    it("resolves anonymous and logged-in ownership without synthetic owners", async () => {
      const owner = await provisionUser(
        provisioning,
        "context-owner@example.com",
        "Context Workspace"
      );
      const anonymousSessions = createAnonymousService(pool, tokens);
      const userSessions = createUserSessionService(pool, tokens);
      const anonymous = await anonymousSessions.create();
      const userSession = await userSessions.create(owner.user.user_id);
      const resolver = new OwnershipContextService(
        userSessions,
        anonymousSessions,
        new WorkspaceAuthorizationService(
          new WorkspaceMemberRepository(pool)
        )
      );

      const anonymousContext = await resolver.resolve({
        userSessionToken: null,
        anonymousSessionToken: anonymous.token,
        workspaceId: null
      });
      assert.deepEqual(anonymousContext, {
        actorType: "anonymous",
        anonymousSessionId: anonymous.session.anonymous_session_id,
        userId: null,
        workspaceId: null
      });

      const userContext = await resolver.resolve({
        userSessionToken: userSession.token,
        anonymousSessionToken: null,
        workspaceId: owner.workspace.workspace_id
      });
      assert.equal(userContext.actorType, "user");
      assert.equal(userContext.userId, owner.user.user_id);
      assert.equal(userContext.workspaceRole, "owner");

      await assertCategory(
        resolver.resolve({
          userSessionToken: userSession.token,
          anonymousSessionToken: anonymous.token,
          workspaceId: owner.workspace.workspace_id
        }),
        "FORBIDDEN"
      );

      await anonymousSessions.claim({
        anonymousSessionId: anonymous.session.anonymous_session_id,
        userId: owner.user.user_id,
        workspaceId: owner.workspace.workspace_id
      });
      const claimedContext = await resolver.resolve({
        userSessionToken: userSession.token,
        anonymousSessionToken: anonymous.token,
        workspaceId: owner.workspace.workspace_id
      });
      assert.equal(claimedContext.actorType, "user");
      assert.equal(
        claimedContext.anonymousSessionId,
        anonymous.session.anonymous_session_id
      );
    });
  }
);

function createAnonymousService(
  pool: pg.Pool,
  tokens: SessionTokenService
) {
  return new AnonymousSessionService(
    new AnonymousSessionRepository(pool),
    pool,
    tokens,
    { ttlSeconds: 3_600 }
  );
}

function createUserSessionService(
  pool: pg.Pool,
  tokens: SessionTokenService
) {
  return new UserSessionService(
    new UserSessionRepository(pool),
    new UserRepository(pool),
    tokens,
    { ttlSeconds: 3_600 }
  );
}

async function provisionUser(
  service: UserProvisioningService,
  email: string,
  workspaceName: string
) {
  return service.createUserWithDefaultWorkspace({
    email,
    defaultWorkspaceName: workspaceName
  });
}

async function assertCategory(
  promise: Promise<unknown>,
  category: ApplicationError["category"]
) {
  await assert.rejects(promise, hasCategory(category));
}

function hasCategory(category: ApplicationError["category"]) {
  return (error: unknown) => {
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.category, category);
    return true;
  };
}
