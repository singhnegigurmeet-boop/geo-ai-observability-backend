import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { ApplicationError } from "../../../src/common/errors/application-error.js";
import type { OwnershipContext } from "../../../src/common/ownership/ownership-context.types.js";
import { AnalysisService } from "../../../src/modules/analysis/services/analysis.service.js";
import { HierarchyDiscoveryService } from "../../../src/modules/discovery/services/hierarchy-discovery.service.js";
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

  it("previews the exact domain target without requiring child discovery or writes", async () => {
    const analyses = new AnalysisService(pool);
    const before = await counts(pool);
    const preview = await analyses.preview({ domain: "preview.example" }, owner);
    assert.equal(preview.hierarchyReady, true);
    assert.equal(preview.discoveryRequired, false);
    assert.deepEqual(preview.estimatedSelectedPathCount, { minimum: 1, maximum: 1 });
    assert.deepEqual(preview.applicablePromptTypes, ["visibility"]);
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
    assert.equal((await analyses.preview({ domain: "viewer-preview.example", promptDepth: "medium" }, viewer)).discoveryRequired, false);
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

  it("returns all authoritative immediate children with a separate breadth limit and no work", async () => {
    const domain = await pool.query<{ domain_id: string }>(
      "INSERT INTO domains(normalized_domain) VALUES('navigation.example') RETURNING domain_id"
    );
    const category = await pool.query<{ category_id: string }>(
      "SELECT category_id FROM categories WHERE normalized_name='software'"
    );
    await pool.query(
      "INSERT INTO domain_categories(domain_id,category_id,source) VALUES($1,$2,'manual')",
      [domain.rows[0]!.domain_id, category.rows[0]!.category_id]
    );
    const additional = await pool.query<{ category_id: string }>(
      `INSERT INTO categories(category_name,normalized_name)
       VALUES ('Navigation A','navigation-a'),('Navigation B','navigation-b'),('Navigation C','navigation-c')
       RETURNING category_id`
    );
    for (const row of additional.rows) {
      await pool.query(
        "INSERT INTO domain_categories(domain_id,category_id,source) VALUES($1,$2,'manual')",
        [domain.rows[0]!.domain_id, row.category_id]
      );
    }
    const before = await counts(pool);

    const result = await new AnalysisService(pool).continueHierarchy(
      { domain: "navigation.example" },
      "db-hit",
      owner
    );

    assert.equal(result.source, "database");
    assert.equal(result.requestedStage, "category");
    assert.equal(result.children.length, 4);
    assert.equal(result.selectionLimit, 3);
    assert.ok(result.children.some((child) => child.entityId === category.rows[0]!.category_id));
    assert.ok(result.children.every((child) => child.canAnalyze && child.canContinue));
    assert.deepEqual(await counts(pool), before);
  });

  it("returns persisted brands, products, and use contexts one level at a time without work", async () => {
    const actor = await createAuthenticatedOwner(pool);
    const hierarchy = await seedCompleteNavigationHierarchy(pool, "deep-navigation.example");
    const before = await counts(pool);
    const analyses = new AnalysisService(pool);

    const brands = await analyses.continueHierarchy(
      { domain: hierarchy.domain, categoryId: hierarchy.categoryId },
      "brand-db-hit",
      actor
    );
    const products = await analyses.continueHierarchy(
      { domain: hierarchy.domain, categoryId: hierarchy.categoryId, brandId: hierarchy.brandId },
      "product-db-hit",
      actor
    );
    const contexts = await analyses.continueHierarchy(
      {
        domain: hierarchy.domain,
        categoryId: hierarchy.categoryId,
        brandId: hierarchy.brandId,
        productId: hierarchy.productId
      },
      "context-db-hit",
      actor
    );
    const anonymousBrands = await analyses.continueHierarchy(
      { domain: hierarchy.domain, categoryId: hierarchy.categoryId },
      "anonymous-brand-db-hit",
      owner
    );

    assert.deepEqual(
      [brands.requestedStage, products.requestedStage, contexts.requestedStage],
      ["brand", "product", "use_context"]
    );
    assert.deepEqual(
      [brands.children[0]?.entityId, products.children[0]?.entityId, contexts.children[0]?.entityId],
      [hierarchy.brandId, hierarchy.productId, hierarchy.useContextId]
    );
    assert.equal(anonymousBrands.children[0]?.canAnalyze, true);
    assert.equal(anonymousBrands.children[0]?.canContinue, false);
    assert.deepEqual(await counts(pool), before);
  });

  it("creates only the explicitly requested brand, product, or use-context discovery stage", async () => {
    const actor = await createAuthenticatedOwner(pool);
    const hierarchy = await seedNavigationParentsWithoutChildren(pool);
    const analyses = new AnalysisService(pool);
    const requests = [
      await analyses.continueHierarchy(
        { domain: hierarchy.brandDomain, categoryId: hierarchy.brandCategoryId },
        "brand-stage-only",
        actor
      ),
      await analyses.continueHierarchy(
        {
          domain: hierarchy.productDomain,
          categoryId: hierarchy.productCategoryId,
          brandId: hierarchy.productBrandId
        },
        "product-stage-only",
        actor
      ),
      await analyses.continueHierarchy(
        {
          domain: hierarchy.contextDomain,
          categoryId: hierarchy.contextCategoryId,
          brandId: hierarchy.contextBrandId,
          productId: hierarchy.contextProductId
        },
        "context-stage-only",
        actor
      )
    ];

    for (const request of requests) {
      assert.equal(request.source, "discovery");
      await new HierarchyDiscoveryService(pool).progress({
        preAnalysisRequestId: request.preAnalysisRequestId!
      });
    }
    const stages = await pool.query<{ pre_analysis_request_id: string; stages: string[] }>(
      `SELECT pre_analysis_request_id,
              array_agg(stage::text ORDER BY stage::text) AS stages
       FROM hierarchy_discovery_jobs
       WHERE pre_analysis_request_id = ANY($1::bigint[])
       GROUP BY pre_analysis_request_id`,
      [requests.map((request) => request.preAnalysisRequestId)]
    );
    const byRequest = new Map(stages.rows.map((row) => [row.pre_analysis_request_id, row.stages]));
    assert.deepEqual(byRequest.get(requests[0]!.preAnalysisRequestId!), ["brand"]);
    assert.deepEqual(byRequest.get(requests[1]!.preAnalysisRequestId!), ["product"]);
    assert.deepEqual(byRequest.get(requests[2]!.preAnalysisRequestId!), ["use_context"]);
    assert.equal((await pool.query("SELECT 1 FROM analysis_runs")).rowCount, 0);
  });

  it("creates one durable category-discovery stage on a navigation miss", async () => {
    const analyses = new AnalysisService(pool);
    const accepted = await analyses.continueHierarchy(
      { domain: "missing-navigation.example" },
      "one-stage",
      owner
    );
    assert.equal(accepted.source, "discovery");
    assert.equal(accepted.status, "pending");
    assert.ok(accepted.preAnalysisRequestId);

    const progress = await new HierarchyDiscoveryService(pool).progress({
      preAnalysisRequestId: accepted.preAnalysisRequestId!
    });
    assert.equal(progress.outcome, "discovering");
    const jobs = await pool.query<{ stage: string; job_kind: string; payload: Record<string, unknown> }>(
      `SELECT discovery.stage::text,provider.job_kind::text,event.payload
       FROM hierarchy_discovery_jobs discovery
       JOIN provider_jobs provider ON provider.discovery_job_id=discovery.hierarchy_discovery_job_id
       JOIN outbox_events event ON event.aggregate_type='provider_job' AND event.aggregate_id=provider.provider_job_id::text
       WHERE discovery.pre_analysis_request_id=$1`,
      [accepted.preAnalysisRequestId]
    );
    assert.equal(jobs.rowCount, 1);
    assert.equal(jobs.rows[0]!.stage, "category");
    assert.equal(jobs.rows[0]!.job_kind, "hierarchy_discovery");
    assert.deepEqual(Object.keys(jobs.rows[0]!.payload), ["providerJobId"]);
    assert.equal((await pool.query("SELECT 1 FROM analysis_runs")).rowCount, 0);
  });

  it("reuses completed navigation only within the same anonymous session", async () => {
    const analyses = new AnalysisService(pool);
    const first = await analyses.continueHierarchy(
      { domain: "navigation-reuse.example" },
      "reuse-first",
      owner
    );
    await pool.query(
      `UPDATE pre_analysis_requests
       SET status='completed_without_analysis',discovery_status='completed_empty',completed_at=now()
       WHERE pre_analysis_request_id=$1`,
      [first.preAnalysisRequestId]
    );
    const sameSession = await analyses.continueHierarchy(
      { domain: "navigation-reuse.example" },
      "reuse-second",
      owner
    );
    const otherSession = await pool.query<{ anonymous_session_id: string }>(
      `INSERT INTO anonymous_sessions(token_hash,expires_at)
       VALUES($1,now()+interval '1 hour') RETURNING anonymous_session_id`,
      [`reuse-other-${crypto.randomUUID()}`]
    );
    const otherOwner: OwnershipContext = {
      actorType: "anonymous",
      anonymousSessionId: otherSession.rows[0]!.anonymous_session_id,
      userId: null,
      workspaceId: null
    };
    const differentSession = await analyses.continueHierarchy(
      { domain: "navigation-reuse.example" },
      "reuse-third",
      otherOwner
    );

    assert.equal(sameSession.preAnalysisRequestId, first.preAnalysisRequestId);
    assert.equal("idempotentReplay" in sameSession && sameSession.idempotentReplay, true);
    assert.notEqual(differentSession.preAnalysisRequestId, first.preAnalysisRequestId);
    assert.equal((await pool.query("SELECT 1 FROM pre_analysis_requests")).rowCount, 2);
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

async function createAuthenticatedOwner(pool: pg.Pool): Promise<OwnershipContext> {
  const user = await pool.query<{ user_id: string }>(
    "INSERT INTO users(email) VALUES($1) RETURNING user_id",
    [`navigation-${crypto.randomUUID()}@example.com`]
  );
  const workspace = await pool.query<{ workspace_id: string }>(
    "INSERT INTO workspaces(workspace_name,created_by_user_id) VALUES($1,$2) RETURNING workspace_id",
    [`Navigation ${crypto.randomUUID()}`, user.rows[0]!.user_id]
  );
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
    [workspace.rows[0]!.workspace_id, user.rows[0]!.user_id]
  );
  return {
    actorType: "user",
    anonymousSessionId: null,
    userId: user.rows[0]!.user_id,
    workspaceId: workspace.rows[0]!.workspace_id,
    workspaceRole: "owner"
  };
}

async function seedCompleteNavigationHierarchy(pool: pg.Pool, domainName: string) {
  const domain = await pool.query<{ domain_id: string }>(
    "INSERT INTO domains(normalized_domain) VALUES($1) RETURNING domain_id",
    [domainName]
  );
  const category = await pool.query<{ category_id: string }>(
    "SELECT category_id FROM categories WHERE normalized_name='software'"
  );
  const suffix = crypto.randomUUID();
  const brand = await pool.query<{ brand_id: string }>(
    "INSERT INTO brands(brand_name,normalized_name) VALUES($1,$2) RETURNING brand_id",
    [`Brand ${suffix}`, `brand-${suffix}`]
  );
  const product = await pool.query<{ product_id: string }>(
    "INSERT INTO products(product_name,normalized_name) VALUES($1,$2) RETURNING product_id",
    [`Product ${suffix}`, `product-${suffix}`]
  );
  const useContext = await pool.query<{ use_context_id: string }>(
    "INSERT INTO use_contexts(use_context_name,normalized_name) VALUES($1,$2) RETURNING use_context_id",
    [`Context ${suffix}`, `context-${suffix}`]
  );
  const domainCategory = await pool.query<{ domain_category_id: string }>(
    "INSERT INTO domain_categories(domain_id,category_id,source) VALUES($1,$2,'manual') RETURNING domain_category_id",
    [domain.rows[0]!.domain_id, category.rows[0]!.category_id]
  );
  const categoryBrand = await pool.query<{ category_brand_id: string }>(
    "INSERT INTO category_brands(domain_category_id,brand_id,source) VALUES($1,$2,'hierarchy') RETURNING category_brand_id",
    [domainCategory.rows[0]!.domain_category_id, brand.rows[0]!.brand_id]
  );
  const brandProduct = await pool.query<{ brand_product_id: string }>(
    "INSERT INTO brand_products(category_brand_id,product_id,source) VALUES($1,$2,'hierarchy') RETURNING brand_product_id",
    [categoryBrand.rows[0]!.category_brand_id, product.rows[0]!.product_id]
  );
  await pool.query(
    "INSERT INTO product_use_contexts(brand_product_id,use_context_id,source) VALUES($1,$2,'hierarchy')",
    [brandProduct.rows[0]!.brand_product_id, useContext.rows[0]!.use_context_id]
  );
  return {
    domain: domainName,
    categoryId: category.rows[0]!.category_id,
    brandId: brand.rows[0]!.brand_id,
    productId: product.rows[0]!.product_id,
    useContextId: useContext.rows[0]!.use_context_id
  };
}

async function seedNavigationParentsWithoutChildren(pool: pg.Pool) {
  const brand = await seedCompleteNavigationHierarchy(pool, "brand-parent.example");
  await pool.query("DELETE FROM product_use_contexts");
  await pool.query("DELETE FROM brand_products");
  await pool.query("DELETE FROM category_brands");

  const product = await seedCompleteNavigationHierarchy(pool, "product-parent.example");
  await pool.query(
    "DELETE FROM product_use_contexts WHERE brand_product_id IN (SELECT bp.brand_product_id FROM brand_products bp JOIN category_brands cb ON cb.category_brand_id=bp.category_brand_id JOIN domain_categories dc ON dc.domain_category_id=cb.domain_category_id JOIN domains d ON d.domain_id=dc.domain_id WHERE d.normalized_domain=$1)",
    [product.domain]
  );
  await pool.query(
    "DELETE FROM brand_products WHERE category_brand_id IN (SELECT cb.category_brand_id FROM category_brands cb JOIN domain_categories dc ON dc.domain_category_id=cb.domain_category_id JOIN domains d ON d.domain_id=dc.domain_id WHERE d.normalized_domain=$1)",
    [product.domain]
  );

  const context = await seedCompleteNavigationHierarchy(pool, "context-parent.example");
  await pool.query(
    "DELETE FROM product_use_contexts WHERE brand_product_id IN (SELECT bp.brand_product_id FROM brand_products bp JOIN category_brands cb ON cb.category_brand_id=bp.category_brand_id JOIN domain_categories dc ON dc.domain_category_id=cb.domain_category_id JOIN domains d ON d.domain_id=dc.domain_id WHERE d.normalized_domain=$1)",
    [context.domain]
  );
  return {
    brandDomain: brand.domain,
    brandCategoryId: brand.categoryId,
    productDomain: product.domain,
    productCategoryId: product.categoryId,
    productBrandId: product.brandId,
    contextDomain: context.domain,
    contextCategoryId: context.categoryId,
    contextBrandId: context.brandId,
    contextProductId: context.productId
  };
}
