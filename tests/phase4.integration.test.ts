import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createAnalysisModule } from "../src/analysis/analysis.module.js";
import { createApp } from "../src/app.js";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../src/db/migration-runner.js";
import { AnonymousSessionRepository } from "../src/identity/anonymous-session.repository.js";
import { AnonymousSessionService } from "../src/identity/anonymous-session.service.js";
import { SessionTokenService } from "../src/identity/session-token.service.js";
import { UserProvisioningService } from "../src/identity/user-provisioning.service.js";
import { UserRepository } from "../src/identity/user.repository.js";
import { UserSessionRepository } from "../src/identity/user-session.repository.js";
import { UserSessionService } from "../src/identity/user-session.service.js";

const runIntegrationTests =
  process.env.RUN_PHASE4_INTEGRATION_TESTS === "true";
const pepper = "phase-4-integration-pepper-with-at-least-32-characters";

type Credentials = {
  userToken?: string;
  workspaceId?: string;
  anonymousToken?: string;
};

type HierarchyFixture = {
  domainId: string;
  categoryA: string;
  categoryB: string;
  brandA: string;
  brandB: string;
  productA: string;
  productB: string;
  useContextA: string;
  useContextB: string;
  fullPathA: string;
};

describe(
  "Phase 4 transactional analysis submission",
  { skip: !runIntegrationTests },
  () => {
    let pool: pg.Pool;
    let server: Server;
    let baseUrl: string;
    let tokens: SessionTokenService;
    let anonymousSessions: AnonymousSessionService;
    let userSessions: UserSessionService;
    let provisioning: UserProvisioningService;
    let hierarchy: HierarchyFixture;

    before(async () => {
      const databaseUrl =
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test";
      pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
      const database = await pool.query<{ database_name: string }>(
        "SELECT current_database() AS database_name"
      );
      const databaseName = database.rows[0]?.database_name;
      if (!databaseName?.endsWith("_test")) {
        throw new Error(
          `Refusing to reset Phase 4 database without _test suffix: ${
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
      anonymousSessions = new AnonymousSessionService(
        new AnonymousSessionRepository(pool),
        pool,
        tokens,
        { ttlSeconds: 3_600 }
      );
      userSessions = new UserSessionService(
        new UserSessionRepository(pool),
        new UserRepository(pool),
        tokens,
        { ttlSeconds: 3_600 }
      );
      provisioning = new UserProvisioningService(pool);
      hierarchy = await seedHierarchy(pool);

      const app = createApp({
        analysisRouter: createAnalysisModule(pool, {
          sessionTokenPepper: pepper,
          userSessionTtlSeconds: 3_600,
          anonymousSessionTtlSeconds: 3_600
        })
      });
      server = await new Promise<Server>((resolve) => {
        const listeningServer = app.listen(0, "127.0.0.1", () =>
          resolve(listeningServer)
        );
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected Phase 4 server to listen on a TCP port");
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      await pool?.end();
    });

    it("keeps health and docs public while analysis remains protected", async () => {
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/docs/`)).status, 200);
      assert.equal(
        (await postAnalysis({}, "public-probe", {})).response.status,
        401
      );
    });

    it("validates domain, idempotency, and contiguous path shape", async () => {
      const anonymous = await createAnonymousOwner();

      assert.equal(
        (await postAnalysis({}, "missing-domain", anonymous)).response.status,
        400
      );
      assert.equal(
        (
          await postAnalysis(
            { domain: "valid.example" },
            null,
            anonymous
          )
        ).response.status,
        400
      );
      assert.equal(
        (
          await postAnalysis(
            { domain: "bad domain.example" },
            "invalid-domain",
            anonymous
          )
        ).response.status,
        400
      );

      for (const [key, body] of [
        [
          "gap-brand",
          { domain: "hierarchy.example", brandId: hierarchy.brandA }
        ],
        [
          "gap-product",
          {
            domain: "hierarchy.example",
            categoryId: hierarchy.categoryA,
            productId: hierarchy.productA
          }
        ],
        [
          "gap-context",
          {
            domain: "hierarchy.example",
            categoryId: hierarchy.categoryA,
            brandId: hierarchy.brandA,
            useContextId: hierarchy.useContextA
          }
        ]
      ] as const) {
        assert.equal(
          (await postAnalysis(body, key, anonymous)).response.status,
          400
        );
      }
    });

    it("persists and exposes only the normalized domain from URL-like input", async () => {
      const anonymous = await createAnonymousOwner();
      const rawDomain =
        "HTTPS://WWW.Normalized-Only.COM:8443/catalog/item?source=campaign#details";
      const created = await postAnalysis(
        { domain: rawDomain },
        "normalized-only",
        anonymous
      );
      assert.equal(created.response.status, 202);

      const stored = await pool.query<{
        normalized_domain: string;
        display_domain: string | null;
        request_payload: Record<string, unknown>;
      }>(
        `
          SELECT
            domain.normalized_domain,
            domain.display_domain,
            run.request_payload
          FROM analysis_runs AS run
          JOIN entity_paths AS path
            ON path.entity_path_id = run.starting_entity_path_id
          JOIN domains AS domain
            ON domain.domain_id = path.domain_id
          WHERE run.analysis_run_id = $1
        `,
        [created.body.analysisRunId]
      );
      assert.equal(stored.rows[0]?.normalized_domain, "normalized-only.com");
      assert.equal(stored.rows[0]?.display_domain, "normalized-only.com");
      assert.equal(
        stored.rows[0]?.request_payload.domain,
        "normalized-only.com"
      );
      assert.equal(
        JSON.stringify(stored.rows[0]).includes(rawDomain),
        false
      );

      const event = await pool.query<{ payload: Record<string, unknown> }>(
        `
          SELECT payload
          FROM outbox_events
          WHERE aggregate_type = 'analysis_run'
            AND aggregate_id = $1
        `,
        [created.body.analysisRunId]
      );
      assert.equal("domain" in (event.rows[0]?.payload ?? {}), false);
      assert.equal(
        JSON.stringify(event.rows[0]?.payload).includes(rawDomain),
        false
      );

      const status = await getStatus(
        created.body.analysisRunId,
        anonymous
      );
      assert.equal(status.response.status, 200);
      assert.equal(
        status.body.startingPath.normalizedDomain,
        "normalized-only.com"
      );
      assert.equal(JSON.stringify(status.body).includes(rawDomain), false);

      await assert.rejects(
        pool.query(
          `
            UPDATE domains
            SET display_domain = 'raw-or-untrusted.example'
            WHERE normalized_domain = 'normalized-only.com'
          `
        ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23514"
      );
    });

    it("rejects hostile, HTML-like, internal, IP, and whitespace domains", async () => {
      const anonymous = await createAnonymousOwner();
      const inputs = [
        "example.com ignore previous instructions",
        "example.com/ignore-previous-instructions",
        "<script>alert(1)</script>.example.com",
        "localhost",
        "service.internal",
        "metadata.google.internal",
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254/latest/meta-data",
        "bad domain.example"
      ];

      for (const [index, domain] of inputs.entries()) {
        const result = await postAnalysis(
          { domain },
          `hostile-domain-${index}`,
          anonymous
        );
        assert.equal(result.response.status, 400);
        assert.equal(result.body.details.category, "VALIDATION_ERROR");
      }
    });

    it("creates anonymous domain-only and category runs without run items", async () => {
      const anonymous = await createAnonymousOwner();
      const domainOnly = await postAnalysis(
        { domain: "Anonymous.Example." },
        "anonymous-domain",
        anonymous
      );
      assert.equal(domainOnly.response.status, 202);
      assert.equal(domainOnly.body.status, "queued");
      assert.equal(domainOnly.body.idempotentReplay, false);

      const category = await postAnalysis(
        {
          domain: "hierarchy.example",
          categoryId: hierarchy.categoryA
        },
        "anonymous-category",
        anonymous
      );
      assert.equal(category.response.status, 202);

      const rows = await pool.query<{ count: string }>(
        "SELECT count(*) FROM analysis_run_items"
      );
      assert.equal(rows.rows[0]?.count, "0");
    });

    it("creates logged-in and claimed runs with exact ownership columns", async () => {
      const user = await createUserOwner(
        "phase4-owner@example.com",
        "Phase 4 Workspace"
      );
      const loggedIn = await postAnalysis(
        { domain: "logged-in.example" },
        "logged-in-run",
        user.credentials
      );
      assert.equal(loggedIn.response.status, 202);

      const loggedRow = await runOwnership(loggedIn.body.analysisRunId);
      assert.equal(loggedRow.anonymous_session_id, null);
      assert.equal(loggedRow.user_id, user.userId);
      assert.equal(loggedRow.workspace_id, user.workspaceId);

      const anonymous = await anonymousSessions.create();
      await anonymousSessions.claim({
        anonymousSessionId: anonymous.session.anonymous_session_id,
        userId: user.userId,
        workspaceId: user.workspaceId
      });
      const claimed = await postAnalysis(
        { domain: "claimed.example" },
        "claimed-run",
        {
          ...user.credentials,
          anonymousToken: anonymous.token
        }
      );
      assert.equal(claimed.response.status, 202);
      const claimedRow = await runOwnership(claimed.body.analysisRunId);
      assert.equal(
        claimedRow.anonymous_session_id,
        anonymous.session.anonymous_session_id
      );
      assert.equal(claimedRow.user_id, user.userId);
      assert.equal(claimedRow.workspace_id, user.workspaceId);
    });

    it("rejects a user token for a workspace without membership", async () => {
      const first = await createUserOwner(
        "phase4-first@example.com",
        "First Workspace"
      );
      const second = await createUserOwner(
        "phase4-second@example.com",
        "Second Workspace"
      );
      const result = await postAnalysis(
        { domain: "workspace-mismatch.example" },
        "workspace-mismatch",
        {
          userToken: first.credentials.userToken,
          workspaceId: second.workspaceId
        }
      );
      assert.equal(result.response.status, 403);
      assert.equal(result.body.details.category, "FORBIDDEN");
    });

    it("reuses normalized domains and exact selected paths", async () => {
      const anonymous = await createAnonymousOwner();
      const first = await postAnalysis(
        { domain: "Reuse.Example." },
        "reuse-domain-1",
        anonymous
      );
      const second = await postAnalysis(
        { domain: "reuse.example" },
        "reuse-domain-2",
        anonymous
      );
      assert.equal(first.response.status, 202);
      assert.equal(second.response.status, 202);
      assert.equal(
        first.body.startingEntityPathId,
        second.body.startingEntityPathId
      );

      const domainCount = await pool.query<{ count: string }>(
        "SELECT count(*) FROM domains WHERE normalized_domain = 'reuse.example'"
      );
      const pathCount = await pool.query<{ count: string }>(
        `
          SELECT count(*)
          FROM entity_paths AS path
          JOIN domains AS domain ON domain.domain_id = path.domain_id
          WHERE domain.normalized_domain = 'reuse.example'
            AND path.path_type = 'domain'
        `
      );
      assert.equal(domainCount.rows[0]?.count, "1");
      assert.equal(pathCount.rows[0]?.count, "1");
    });

    it("implements owner-scoped normalized-request idempotency", async () => {
      const firstOwner = await createAnonymousOwner();
      const secondOwner = await createAnonymousOwner();
      const initial = await postAnalysis(
        { domain: "Replay.Example." },
        "shared-client-key",
        firstOwner
      );
      const replay = await postAnalysis(
        { domain: "replay.example" },
        "shared-client-key",
        firstOwner
      );
      assert.equal(replay.response.status, 202);
      assert.equal(replay.body.analysisRunId, initial.body.analysisRunId);
      assert.equal(replay.body.idempotentReplay, true);
      const replayEvents = await pool.query<{ count: string }>(
        "SELECT count(*) FROM outbox_events WHERE aggregate_id = $1",
        [initial.body.analysisRunId]
      );
      assert.equal(replayEvents.rows[0]?.count, "1");

      const conflict = await postAnalysis(
        { domain: "different.example" },
        "shared-client-key",
        firstOwner
      );
      assert.equal(conflict.response.status, 409);
      assert.equal(conflict.body.details.category, "CONFLICT");

      const otherOwner = await postAnalysis(
        { domain: "replay.example" },
        "shared-client-key",
        secondOwner
      );
      assert.equal(otherOwner.response.status, 202);
      assert.notEqual(
        otherOwner.body.analysisRunId,
        initial.body.analysisRunId
      );
    });

    it("validates parent relationships and accepts each valid deep path", async () => {
      const anonymous = await createAnonymousOwner();
      for (const [key, body] of [
        [
          "bad-brand-parent",
          {
            domain: "hierarchy.example",
            categoryId: hierarchy.categoryA,
            brandId: hierarchy.brandB
          }
        ],
        [
          "bad-product-parent",
          {
            domain: "hierarchy.example",
            categoryId: hierarchy.categoryA,
            brandId: hierarchy.brandA,
            productId: hierarchy.productB
          }
        ],
        [
          "bad-context-parent",
          {
            domain: "hierarchy.example",
            categoryId: hierarchy.categoryA,
            brandId: hierarchy.brandA,
            productId: hierarchy.productA,
            useContextId: hierarchy.useContextB
          }
        ]
      ] as const) {
        const result = await postAnalysis(body, key, anonymous);
        assert.equal(result.response.status, 400);
        assert.equal(result.body.details.category, "VALIDATION_ERROR");
      }

      const validBodies = [
        {
          domain: "hierarchy.example",
          categoryId: hierarchy.categoryA,
          brandId: hierarchy.brandA
        },
        {
          domain: "hierarchy.example",
          categoryId: hierarchy.categoryA,
          brandId: hierarchy.brandA,
          productId: hierarchy.productA
        },
        {
          domain: "hierarchy.example",
          categoryId: hierarchy.categoryA,
          brandId: hierarchy.brandA,
          productId: hierarchy.productA,
          useContextId: hierarchy.useContextA
        }
      ];
      for (const [index, body] of validBodies.entries()) {
        const result = await postAnalysis(
          body,
          `valid-deep-${index}`,
          anonymous
        );
        assert.equal(result.response.status, 202);
      }

      const full = await postAnalysis(
        validBodies[2],
        "valid-full-reuse",
        anonymous
      );
      assert.equal(full.body.startingEntityPathId, hierarchy.fullPathA);
    });

    it("rejects missing DB-controlled hierarchy master records", async () => {
      const anonymous = await createAnonymousOwner();
      const missingId = "9223372036854775807";
      for (const [key, body] of [
        [
          "missing-category",
          {
            domain: "hierarchy.example",
            categoryId: missingId
          }
        ],
        [
          "missing-brand",
          {
            domain: "hierarchy.example",
            categoryId: hierarchy.categoryA,
            brandId: missingId
          }
        ],
        [
          "missing-product",
          {
            domain: "hierarchy.example",
            categoryId: hierarchy.categoryA,
            brandId: hierarchy.brandA,
            productId: missingId
          }
        ],
        [
          "missing-context",
          {
            domain: "hierarchy.example",
            categoryId: hierarchy.categoryA,
            brandId: hierarchy.brandA,
            productId: hierarchy.productA,
            useContextId: missingId
          }
        ]
      ] as const) {
        const result = await postAnalysis(body, key, anonymous);
        assert.equal(result.response.status, 404);
        assert.equal(result.body.details.category, "NOT_FOUND");
      }
    });

    it("writes exactly one ID-oriented outbox event with each new run", async () => {
      const anonymous = await createAnonymousOwner();
      const created = await postAnalysis(
        { domain: "outbox.example" },
        "outbox-event",
        anonymous
      );
      assert.equal(created.response.status, 202);

      const event = await pool.query<{
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        headers: Record<string, unknown>;
        payload: Record<string, unknown>;
      }>(
        `
          SELECT event_type, aggregate_type, aggregate_id, headers, payload
          FROM outbox_events
          WHERE event_key = $1
        `,
        [`analysis_run.created:${created.body.analysisRunId}`]
      );
      assert.equal(event.rowCount, 1);
      assert.equal(event.rows[0]?.event_type, "analysis_run.created");
      assert.equal(event.rows[0]?.aggregate_type, "analysis_run");
      assert.equal(
        event.rows[0]?.aggregate_id,
        created.body.analysisRunId
      );
      assert.deepEqual(event.rows[0]?.headers, {
        queueName: "analysis_run_queue"
      });
      assert.deepEqual(
        Object.keys(event.rows[0]?.payload ?? {}).sort(),
        [
          "actorType",
          "analysisRunId",
          "anonymousSessionId",
          "startingEntityPathId",
          "userId",
          "workspaceId"
        ].sort()
      );
      assert.equal(
        Object.values(event.rows[0]?.payload ?? {}).some(
          (value) => value === "outbox.example"
        ),
        false
      );
      const runItems = await pool.query<{ count: string }>(
        "SELECT count(*) FROM analysis_run_items"
      );
      assert.equal(runItems.rows[0]?.count, "0");
    });

    it("rolls back the analysis run when outbox insertion fails", async () => {
      const anonymous = await createAnonymousOwner();
      await pool.query(`
        CREATE FUNCTION phase4_reject_outbox()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'phase4 forced outbox failure';
        END;
        $$
      `);
      await pool.query(`
        CREATE TRIGGER phase4_reject_outbox_trigger
        BEFORE INSERT ON outbox_events
        FOR EACH ROW
        EXECUTE FUNCTION phase4_reject_outbox()
      `);

      try {
        const failed = await postAnalysis(
          { domain: "rollback.example" },
          "rollback-event",
          anonymous
        );
        assert.equal(failed.response.status, 500);
      } finally {
        await pool.query(
          "DROP TRIGGER phase4_reject_outbox_trigger ON outbox_events"
        );
        await pool.query("DROP FUNCTION phase4_reject_outbox()");
      }

      const run = await pool.query<{ count: string }>(
        `
          SELECT count(*)
          FROM analysis_runs
          WHERE idempotency_key = $1
        `,
        [
          `anonymous:${anonymous.anonymousSessionId}:rollback-event`
        ]
      );
      const domain = await pool.query<{ count: string }>(
        "SELECT count(*) FROM domains WHERE normalized_domain = 'rollback.example'"
      );
      assert.equal(run.rows[0]?.count, "0");
      assert.equal(domain.rows[0]?.count, "0");
    });

    it("returns queued status without progress and enforces anonymous ownership", async () => {
      const owner = await createAnonymousOwner();
      const other = await createAnonymousOwner();
      const created = await postAnalysis(
        { domain: "anonymous-status.example" },
        "anonymous-status",
        owner
      );

      const status = await getStatus(created.body.analysisRunId, owner);
      assert.equal(status.response.status, 200);
      assert.equal(status.body.status, "queued");
      assert.equal(status.body.startedAt, null);
      assert.equal(status.body.completedAt, null);
      assert.equal("progress" in status.body, false);
      assert.equal("reports" in status.body, false);
      assert.equal("scores" in status.body, false);

      assert.equal(
        (await getStatus(created.body.analysisRunId, other)).response.status,
        404
      );
    });

    it("enforces user and workspace ownership on status reads", async () => {
      const owner = await createUserOwner(
        "status-owner@example.com",
        "Status Owner"
      );
      const other = await createUserOwner(
        "status-other@example.com",
        "Status Other"
      );
      const created = await postAnalysis(
        { domain: "user-status.example" },
        "user-status",
        owner.credentials
      );
      assert.equal(
        (
          await getStatus(
            created.body.analysisRunId,
            owner.credentials
          )
        ).response.status,
        200
      );
      assert.equal(
        (
          await getStatus(
            created.body.analysisRunId,
            other.credentials
          )
        ).response.status,
        404
      );
    });

    async function createAnonymousOwner() {
      const created = await anonymousSessions.create();
      return {
        anonymousToken: created.token,
        anonymousSessionId: created.session.anonymous_session_id
      };
    }

    async function createUserOwner(email: string, workspaceName: string) {
      const provisioned =
        await provisioning.createUserWithDefaultWorkspace({
          email,
          defaultWorkspaceName: workspaceName
        });
      const session = await userSessions.create(provisioned.user.user_id);
      return {
        userId: provisioned.user.user_id,
        workspaceId: provisioned.workspace.workspace_id,
        credentials: {
          userToken: session.token,
          workspaceId: provisioned.workspace.workspace_id
        }
      };
    }

    async function postAnalysis(
      body: Record<string, unknown>,
      idempotencyKey: string | null,
      credentials: Credentials
    ) {
      const response = await fetch(`${baseUrl}/v1/analysis`, {
        method: "POST",
        headers: requestHeaders(credentials, idempotencyKey),
        body: JSON.stringify(body)
      });
      return {
        response,
        body: (await response.json()) as Record<string, any>
      };
    }

    async function getStatus(
      analysisRunId: string,
      credentials: Credentials
    ) {
      const response = await fetch(
        `${baseUrl}/v1/analysis/runs/${analysisRunId}`,
        { headers: requestHeaders(credentials, null) }
      );
      return {
        response,
        body: (await response.json()) as Record<string, any>
      };
    }

    function requestHeaders(
      credentials: Credentials,
      idempotencyKey: string | null
    ) {
      const headers: Record<string, string> = {
        "content-type": "application/json"
      };
      if (credentials.userToken) {
        headers.authorization = `Bearer ${credentials.userToken}`;
      }
      if (credentials.workspaceId) {
        headers["x-workspace-id"] = credentials.workspaceId;
      }
      if (credentials.anonymousToken) {
        headers["x-anonymous-session-token"] =
          credentials.anonymousToken;
      }
      if (idempotencyKey) {
        headers["idempotency-key"] = idempotencyKey;
      }
      return headers;
    }

    async function runOwnership(analysisRunId: string) {
      const result = await pool.query<{
        anonymous_session_id: string | null;
        user_id: string | null;
        workspace_id: string | null;
      }>(
        `
          SELECT anonymous_session_id, user_id, workspace_id
          FROM analysis_runs
          WHERE analysis_run_id = $1
        `,
        [analysisRunId]
      );
      return result.rows[0] as {
        anonymous_session_id: string | null;
        user_id: string | null;
        workspace_id: string | null;
      };
    }
  }
);

async function seedHierarchy(pool: pg.Pool): Promise<HierarchyFixture> {
  const domain = await pool.query<{ domain_id: string }>(
    `
      INSERT INTO domains (normalized_domain, display_domain)
      VALUES ('hierarchy.example', 'hierarchy.example')
      RETURNING domain_id
    `
  );
  const categories = await pool.query<{ category_id: string }>(
    `
      INSERT INTO categories (category_name, normalized_name)
      VALUES ('Category A', 'phase4-category-a'),
             ('Category B', 'phase4-category-b')
      RETURNING category_id
    `
  );
  const brands = await pool.query<{ brand_id: string }>(
    `
      INSERT INTO brands (brand_name, normalized_name)
      VALUES ('Brand A', 'phase4-brand-a'),
             ('Brand B', 'phase4-brand-b')
      RETURNING brand_id
    `
  );
  const products = await pool.query<{ product_id: string }>(
    `
      INSERT INTO products (product_name, normalized_name)
      VALUES ('Product A', 'phase4-product-a'),
             ('Product B', 'phase4-product-b')
      RETURNING product_id
    `
  );
  const contexts = await pool.query<{ use_context_id: string }>(
    `
      INSERT INTO use_contexts (use_context_name, normalized_name)
      VALUES ('Use Context A', 'phase4-use-context-a'),
             ('Use Context B', 'phase4-use-context-b')
      RETURNING use_context_id
    `
  );

  const domainId = domain.rows[0]!.domain_id;
  const categoryA = categories.rows[0]!.category_id;
  const categoryB = categories.rows[1]!.category_id;
  const brandA = brands.rows[0]!.brand_id;
  const brandB = brands.rows[1]!.brand_id;
  const productA = products.rows[0]!.product_id;
  const productB = products.rows[1]!.product_id;
  const useContextA = contexts.rows[0]!.use_context_id;
  const useContextB = contexts.rows[1]!.use_context_id;

  const paths = await pool.query<{ entity_path_id: string }>(
    `
      INSERT INTO entity_paths (
        domain_id,
        category_id,
        brand_id,
        product_id,
        use_context_id,
        path_type
      )
      VALUES
        ($1, $2, $3, $4, $5, 'use_context'),
        ($1, $6, $7, $8, $9, 'use_context')
      RETURNING entity_path_id
    `,
    [
      domainId,
      categoryA,
      brandA,
      productA,
      useContextA,
      categoryB,
      brandB,
      productB,
      useContextB
    ]
  );

  return {
    domainId,
    categoryA,
    categoryB,
    brandA,
    brandB,
    productA,
    productB,
    useContextA,
    useContextB,
    fullPathA: paths.rows[0]!.entity_path_id
  };
}
