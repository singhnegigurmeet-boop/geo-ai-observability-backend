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
});

async function counts(pool: pg.Pool) {
  const result = await pool.query<{ requests: string; runs: string; jobs: string; events: string }>(
    `SELECT (SELECT count(*)::text FROM pre_analysis_requests) requests,
            (SELECT count(*)::text FROM analysis_runs) runs,
            (SELECT count(*)::text FROM provider_jobs) jobs,
            (SELECT count(*)::text FROM outbox_events) events`
  );
  return result.rows[0]!;
}
