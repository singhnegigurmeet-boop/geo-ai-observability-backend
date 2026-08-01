import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { ApplicationError } from "../../../src/common/errors/application-error.js";
import type { OwnershipContext } from "../../../src/common/ownership/ownership-context.types.js";
import { AnalysisService } from "../../../src/modules/analysis/services/analysis.service.js";
import { createIntegrationPool, resetTestSchema, truncatePublicTables } from "../../support/integration-environment.js";

const enabled = process.env.RUN_ANALYSIS_API_INTEGRATION_TESTS === "true";

describe("Transactional pre-analysis API integration", { skip: !enabled, concurrency: 1 }, () => {
  let pool: pg.Pool;
  let owner: OwnershipContext;

  before(async () => { pool = createIntegrationPool(); await resetTestSchema(pool); });
  beforeEach(async () => {
    await truncatePublicTables(pool);
    const session = await pool.query<{ anonymous_session_id: string }>(
      `INSERT INTO anonymous_sessions (token_hash, expires_at) VALUES ($1, now()+interval '1 hour') RETURNING anonymous_session_id`,
      [`test-${crypto.randomUUID()}`]
    );
    owner = { actorType: "anonymous", anonymousSessionId: session.rows[0]!.anonymous_session_id, userId: null, workspaceId: null };
    await pool.query(`INSERT INTO categories (category_name, normalized_name) VALUES ('Software', 'software')`);
  });

  it("accepts a durable owner-scoped request before any analysis run exists", async () => {
    const created = await new AnalysisService(pool).create({ domain: "Example.COM." }, "accept-once", owner);
    assert.equal(created.status, "accepted");
    assert.equal(created.analysisRunId, null);
    const state = await pool.query<{ normalized_domain: string; run_count: string; event_type: string; payload: Record<string, unknown> }>(
      `SELECT d.normalized_domain,
              (SELECT count(*)::text FROM analysis_runs) run_count,
              e.event_type,e.payload
       FROM pre_analysis_requests r JOIN domains d ON d.domain_id=r.domain_id
       JOIN outbox_events e ON e.aggregate_id=r.pre_analysis_request_id::text AND e.aggregate_type='pre_analysis_request'
       WHERE r.pre_analysis_request_id=$1`, [created.preAnalysisRequestId]
    );
    assert.equal(state.rows[0]!.normalized_domain, "example.com");
    assert.equal(state.rows[0]!.run_count, "0");
    assert.equal(state.rows[0]!.event_type, "pre_analysis_request.accepted");
    assert.deepEqual(Object.keys(state.rows[0]!.payload), ["preAnalysisRequestId"]);
  });

  it("moves idempotency to the pre-analysis boundary", async () => {
    const analyses = new AnalysisService(pool);
    const first = await analyses.create({ domain: "idempotent.example" }, "same", owner);
    const replay = await analyses.create({ domain: "IDEMPOTENT.EXAMPLE." }, "same", owner);
    assert.equal(replay.preAnalysisRequestId, first.preAnalysisRequestId);
    assert.equal(replay.idempotentReplay, true);
    await assert.rejects(
      analyses.create({ domain: "different.example" }, "same", owner),
      (error) => error instanceof ApplicationError && error.category === "CONFLICT"
    );
    assert.equal((await pool.query("SELECT 1 FROM pre_analysis_requests")).rowCount, 1);
  });

  it("enforces ownership on pre-analysis status", async () => {
    const analyses = new AnalysisService(pool);
    const created = await analyses.create({ domain: "owned.example" }, "owned", owner);
    assert.equal((await analyses.getRequestStatus(created.preAnalysisRequestId, owner)).status, "accepted");
    const otherSession = await pool.query<{ anonymous_session_id: string }>(
      `INSERT INTO anonymous_sessions (token_hash, expires_at) VALUES ($1,now()+interval '1 hour') RETURNING anonymous_session_id`,
      [`other-${crypto.randomUUID()}`]
    );
    const other: OwnershipContext = { actorType: "anonymous", anonymousSessionId: otherSession.rows[0]!.anonymous_session_id, userId: null, workspaceId: null };
    await assert.rejects(
      analyses.getRequestStatus(created.preAnalysisRequestId, other),
      (error) => error instanceof ApplicationError && error.category === "NOT_FOUND"
    );
  });

  it("keeps incomplete-hierarchy preview read-only", async () => {
    const analyses = new AnalysisService(pool);
    const before = await counts(pool);
    const preview = await analyses.preview({ domain: "preview.example" }, owner);
    assert.equal(preview.hierarchyReady, false);
    assert.equal(preview.discoveryRequired, true);
    assert.deepEqual(await counts(pool), before);
  });

  it("allows viewer preview and owned reads while denying mutations without writes", async () => {
    const user = await pool.query<{ user_id: string }>("INSERT INTO users(email) VALUES($1) RETURNING user_id", [`viewer-${crypto.randomUUID()}@example.com`]);
    const workspace = await pool.query<{ workspace_id: string }>("INSERT INTO workspaces(workspace_name,created_by_user_id) VALUES($1,$2) RETURNING workspace_id", [`Viewer ${crypto.randomUUID()}`, user.rows[0]!.user_id]);
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'viewer')", [workspace.rows[0]!.workspace_id, user.rows[0]!.user_id]);
    const viewer: OwnershipContext = { actorType: "user", anonymousSessionId: null, userId: user.rows[0]!.user_id, workspaceId: workspace.rows[0]!.workspace_id, workspaceRole: "viewer" };
    const domain = await pool.query<{ domain_id: string }>("INSERT INTO domains(normalized_domain) VALUES($1) RETURNING domain_id", [`viewer-${crypto.randomUUID()}.example`]);
    const path = await pool.query<{ entity_path_id: string }>("INSERT INTO entity_paths(domain_id,path_type) VALUES($1,'domain') RETURNING entity_path_id", [domain.rows[0]!.domain_id]);
    const request = await pool.query<{ pre_analysis_request_id: string }>(
      `INSERT INTO pre_analysis_requests(idempotency_key,user_id,workspace_id,domain_id,starting_entity_path_id,category_selection_mode,prompt_depth,source,status,request_payload,canonical_request_hash,discovery_compatibility_hash)
       VALUES($1,$2,$3,$4,$5,'all','medium','manual','accepted','{}',$6,$6) RETURNING pre_analysis_request_id`,
      [`viewer-request-${crypto.randomUUID()}`, viewer.userId, viewer.workspaceId, domain.rows[0]!.domain_id, path.rows[0]!.entity_path_id, "c".repeat(64)]
    );
    const run = await pool.query<{ analysis_run_id: string }>(
      `INSERT INTO analysis_runs(idempotency_key,user_id,workspace_id,starting_entity_path_id,category_selection_mode,prompt_depth,prompt_policy_version,source,status,request_payload)
       VALUES($1,$2,$3,$4,'all','medium','geo-prompt-policy-v1','manual','queued','{}') RETURNING analysis_run_id`,
      [`viewer-run-${crypto.randomUUID()}`, viewer.userId, viewer.workspaceId, path.rows[0]!.entity_path_id]
    );
    await pool.query(
      `INSERT INTO reports(idempotency_key,analysis_run_id,report_version,revision,status,report_data,rendered_text)
       VALUES($1,$2,'multi-provider-report-v1',1,'completed','{}','viewer report')`,
      [`viewer-report-${crypto.randomUUID()}`, run.rows[0]!.analysis_run_id]
    );
    const analyses = new AnalysisService(pool);

    const before = await counts(pool);
    assert.equal((await analyses.preview({ domain: "viewer-preview.example" }, viewer)).discoveryRequired, true);
    assert.equal((await analyses.getRequestStatus(request.rows[0]!.pre_analysis_request_id, viewer)).status, "accepted");
    assert.equal((await analyses.getStatus(run.rows[0]!.analysis_run_id, viewer)).status, "queued");
    assert.equal((await analyses.getReport(run.rows[0]!.analysis_run_id, viewer)).renderedText, "viewer report");
    await assert.rejects(
      analyses.create({ domain: "viewer-create.example", promptDepth: "medium" }, "viewer-create", viewer),
      (error) => error instanceof ApplicationError && error.category === "FORBIDDEN"
    );
    await assert.rejects(
      analyses.cancel(run.rows[0]!.analysis_run_id, viewer),
      (error) => error instanceof ApplicationError && error.category === "FORBIDDEN"
    );
    assert.deepEqual(await counts(pool), before);
    assert.equal((await analyses.getStatus(run.rows[0]!.analysis_run_id, viewer)).status, "queued");
  });

  it("preserves analysis creation for owner, admin, and member", async () => {
    const user = await pool.query<{ user_id: string }>("INSERT INTO users(email) VALUES($1) RETURNING user_id", [`mutation-${crypto.randomUUID()}@example.com`]);
    const workspace = await pool.query<{ workspace_id: string }>("INSERT INTO workspaces(workspace_name,created_by_user_id) VALUES($1,$2) RETURNING workspace_id", [`Mutation ${crypto.randomUUID()}`, user.rows[0]!.user_id]);
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspace.rows[0]!.workspace_id, user.rows[0]!.user_id]);
    const analyses = new AnalysisService(pool);
    for (const role of ["owner", "admin", "member"] as const) {
      await pool.query("UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2", [workspace.rows[0]!.workspace_id, user.rows[0]!.user_id, role]);
      const actor: OwnershipContext = { actorType: "user", anonymousSessionId: null, userId: user.rows[0]!.user_id, workspaceId: workspace.rows[0]!.workspace_id, workspaceRole: role };
      assert.equal((await analyses.create({ domain: `${role}.mutation.example`, promptDepth: "medium" }, `mutation-${role}`, actor)).status, "accepted");
    }
    assert.equal((await pool.query("SELECT 1 FROM pre_analysis_requests")).rowCount, 3);
  });
});

async function counts(pool: pg.Pool) {
  const result = await pool.query<{ requests: string; requestedCategories: string; discoveryJobs: string; runs: string; jobs: string; events: string }>(
    `SELECT (SELECT count(*)::text FROM pre_analysis_requests) requests,
            (SELECT count(*)::text FROM analysis_run_requested_categories) "requestedCategories",
            (SELECT count(*)::text FROM hierarchy_discovery_jobs) "discoveryJobs",
            (SELECT count(*)::text FROM analysis_runs) runs,
            (SELECT count(*)::text FROM provider_jobs) jobs,
            (SELECT count(*)::text FROM outbox_events) events`
  );
  return result.rows[0]!;
}
