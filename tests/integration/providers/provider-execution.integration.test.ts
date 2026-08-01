import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { ProviderAdapterRegistry } from "../../../src/modules/providers/adapters/provider-adapter.registry.js";
import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderGeneratedOutput
} from "../../../src/modules/providers/types/provider-adapter.types.js";
import { ProviderExecutionError } from "../../../src/modules/providers/errors/provider-execution.error.js";
import { ProviderExecutionService } from "../../../src/modules/providers/services/provider-execution.service.js";
import type { ProviderJobCreatedPayload } from "../../../src/modules/providers/messages/provider-worker.messages.js";
import { ProviderScoreService } from "../../../src/modules/scoring/services/provider-score.service.js";
import type { PromptType, ProviderName } from "../../../src/common/types/database.types.js";
import type { EntityPathType } from "../../../src/common/types/database.types.js";
import { promptTypePolicy } from "../../../src/modules/prompts/policies/prompt-policy.registry.js";
import { providerModelProfile } from "../../../src/modules/providers/registry/provider-model.registry.js";
import {
  createIntegrationPool,
  resetTestSchema,
  truncatePublicTables
} from "../../support/integration-environment.js";
import { AuthoritativeEntityPathContextRepository } from "../../../src/modules/providers/repositories/authoritative-entity-path-context.repository.js";

const enabled = process.env.RUN_PROVIDER_EXECUTION_INTEGRATION_TESTS === "true";

describe("Real provider execution integration", { skip: !enabled, concurrency: 1 }, () => {
  let pool: pg.Pool;

  before(async () => {
    pool = createIntegrationPool();
    await resetTestSchema(pool);
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
  });

  after(async () => pool?.end());

  it("executes OpenAI, Gemini, and Claude adapters and reconciles actual usage", async () => {
    for (const [provider, model] of providerModels()) {
      const fixture = await seedRun(pool, provider, model, ["visibility"]);
      const adapter = new FakeAdapter(provider, model, provider === "gemini");
      const service = new ProviderExecutionService(
        pool,
        new ProviderAdapterRegistry([adapter]),
        500
      );
      const outcome = await service.execute(fixture.jobs[0]!.payload);
      assert.equal(outcome.outcome, "completed");
      assert.equal(adapter.calls, 1);
      const persisted = await pool.query<{
        provider: string;
        provider_request_id: string;
        finish_reason: string;
        input_tokens: string;
        output_tokens: string;
        estimated_count: string;
      }>(
        `
          SELECT result.provider, result.provider_request_id,
                 result.finish_reason, actual.input_tokens,
                 actual.output_tokens,
                 count(estimated.token_usage_id)::text AS estimated_count
          FROM provider_results AS result
          JOIN token_usage AS actual
            ON actual.provider_job_id = result.provider_job_id
           AND actual.usage_kind = 'actual'
          LEFT JOIN token_usage AS estimated
            ON estimated.provider_job_id = result.provider_job_id
           AND estimated.usage_kind = 'estimated'
          WHERE result.provider_job_id = $1
          GROUP BY result.provider_result_id, actual.token_usage_id
        `,
        [fixture.jobs[0]!.providerJobId]
      );
      assert.equal(persisted.rows[0]?.provider, provider);
      assert.equal(
        persisted.rows[0]?.provider_request_id,
        `${provider}-request:${fixture.jobs[0]!.providerJobId}`
      );
      assert.equal(persisted.rows[0]?.finish_reason, "stop");
      assert.equal(persisted.rows[0]?.estimated_count, "1");
      assert.ok(Number(persisted.rows[0]?.input_tokens) > 0);
      assert.ok(Number(persisted.rows[0]?.output_tokens) > 0);
    }
  });

  it("blocks on hard budget before invoking a real adapter", async () => {
    const fixture = await seedRun(pool, "openai", "gpt-4o-mini", ["ranking"]);
    await pool.query(
      `
        INSERT INTO budget_policies (
          budget_scope, analysis_run_id, provider, model,
          limit_mode, window_seconds, token_limit
        )
        VALUES ('analysis_run', $1, 'openai', 'gpt-4o-mini', 'hard', 3600, 1)
      `,
      [fixture.analysisRunId]
    );
    const adapter = new FakeAdapter("openai", "gpt-4o-mini");
    const outcome = await new ProviderExecutionService(
      pool,
      new ProviderAdapterRegistry([adapter]),
      500
    ).execute(fixture.jobs[0]!.payload);
    assert.equal(outcome.outcome, "paused_budget");
    assert.equal(adapter.calls, 0);
    assert.equal(await count(pool, "provider_results"), 0);
    assert.equal(await count(pool, "token_usage"), 0);
  });

  it("rolls retryable provider errors back and permits a clean retry", async () => {
    const fixture = await seedRun(pool, "claude", "claude-3-5-sonnet", ["pros_cons"]);
    const failing = new FakeAdapter("claude", "claude-3-5-sonnet");
    failing.error = new ProviderExecutionError("PROVIDER_TIMEOUT", "timed out");
    await assert.rejects(
      new ProviderExecutionService(
        pool,
        new ProviderAdapterRegistry([failing]),
        500
      ).execute(fixture.jobs[0]!.payload),
      /timed out/
    );
    assert.equal(await count(pool, "provider_results"), 0);
    assert.equal(await count(pool, "token_usage"), 0);
    const succeeding = new FakeAdapter("claude", "claude-3-5-sonnet");
    assert.equal(
      (
        await new ProviderExecutionService(
          pool,
          new ProviderAdapterRegistry([succeeding]),
          500
        ).execute(fixture.jobs[0]!.payload)
      ).outcome,
      "completed"
    );
  });

  it("persists malformed successful responses as invalid, unscored evidence", async () => {
    const fixture = await seedRun(
      pool,
      "openai",
      "gpt-4o-mini",
      ["visibility"],
      true
    );
    const adapter = new FakeAdapter("openai", "gpt-4o-mini");
    adapter.error = new ProviderExecutionError(
      "PROVIDER_RESPONSE_INVALID",
      "malformed provider response",
      true,
      {
        rawResponse: { unexpected: "retained safely" },
        validationErrors: ["evidence must be an array"]
      }
    );
    const outcome = await new ProviderExecutionService(
      pool,
      new ProviderAdapterRegistry([adapter]),
      500
    ).execute(fixture.jobs[0]!.payload);
    assert.equal(outcome.outcome, "completed");
    const evidence = await pool.query<{
      status: string;
      raw_response: string;
      validation_errors: string[];
      job_status: string;
    }>(
      `SELECT result.status, result.raw_response,
              result.validation_errors, job.status AS job_status
       FROM provider_results AS result
       JOIN provider_jobs AS job
         ON job.provider_job_id = result.provider_job_id`
    );
    assert.deepEqual(evidence.rows, [
      {
        status: "invalid",
        raw_response: '{"unexpected":"retained safely"}',
        validation_errors: [
          {
            layer: "provider_transport",
            code: "GENERATED_CONTENT_MISSING",
            message: "evidence must be an array"
          }
        ],
        job_status: "succeeded"
      }
    ]);
    assert.equal(await count(pool, "provider_scores"), 0);
    assert.equal(await count(pool, "reports"), 0);
  });

  it("persists a frozen-context mismatch as terminal invalid evidence without scoring", async () => {
    const fixture = await seedRun(
      pool,
      "openai",
      "gpt-4o-mini",
      ["visibility"]
    );
    await pool.query(
      `
        UPDATE prompt_jobs
        SET input_payload =
          jsonb_set(input_payload, '{entityPathContext,domain,name}', '"changed.example"')
        WHERE prompt_job_id = $1
      `,
      [fixture.jobs[0]!.promptJobId]
    );
    const adapter = new FakeAdapter("openai", "gpt-4o-mini");
    const service = new ProviderExecutionService(
      pool,
      new ProviderAdapterRegistry([adapter]),
      500
    );
    const first = await service.execute(fixture.jobs[0]!.payload);
    assert.equal(first.outcome, "completed");
    assert.equal((await service.execute(fixture.jobs[0]!.payload)).outcome, "noop");

    const evidence = await pool.query<{
      status: string;
      validated_response: unknown;
      context_validation_status: string;
      raw_response: string;
      raw_response_truncated: boolean;
      raw_response_original_bytes: number;
      validation_errors: Array<{ code: string }>;
      job_status: string;
    }>(
      `
        SELECT result.status, result.validated_response,
               result.context_validation_status, result.raw_response,
               result.raw_response_truncated,
               result.raw_response_original_bytes,
               result.validation_errors, job.status AS job_status
        FROM provider_results AS result
        JOIN provider_jobs AS job
          ON job.provider_job_id = result.provider_job_id
      `
    );
    assert.equal(evidence.rows.length, 1);
    assert.equal(evidence.rows[0]!.status, "invalid");
    assert.equal(evidence.rows[0]!.validated_response, null);
    assert.equal(evidence.rows[0]!.context_validation_status, "invalid");
    assert.equal(evidence.rows[0]!.job_status, "succeeded");
    assert.ok(evidence.rows[0]!.raw_response.length > 0);
    assert.equal(evidence.rows[0]!.raw_response_truncated, false);
    assert.equal(
      evidence.rows[0]!.raw_response_original_bytes,
      Buffer.byteLength(evidence.rows[0]!.raw_response)
    );
    assert.ok(
      evidence.rows[0]!.validation_errors.some(
        (error) => error.code === "ENTITY_PATH_DOMAIN_MISMATCH"
      )
    );
    assert.equal(await count(pool, "provider_results"), 1);
    assert.equal(await count(pool, "provider_scores"), 0);
    assert.equal(
      Number(
        (
          await pool.query<{ count: string }>(
            `SELECT count(*) FROM outbox_events
             WHERE event_type = 'provider_result.created'`
          )
        ).rows[0]!.count
      ),
      0
    );
  });

  it("rejects an authoritative path with a missing relationship", async () => {
    const fixture = await seedRun(
      pool,
      "openai",
      "gpt-4o-mini",
      ["visibility"]
    );
    await moveFixtureToUnrelatedCategoryPath(pool, fixture.jobs[0]!.promptJobId);
    const result = await new ProviderExecutionService(
      pool,
      new ProviderAdapterRegistry([
        new FakeAdapter("openai", "gpt-4o-mini")
      ]),
      500
    ).execute(fixture.jobs[0]!.payload);
    assert.equal(result.outcome, "completed");
    const persisted = await pool.query<{
      status: string;
      context_validation_status: string;
      validation_errors: Array<{ code: string }>;
    }>(
      `SELECT status, context_validation_status, validation_errors
       FROM provider_results`
    );
    assert.equal(persisted.rows[0]!.status, "invalid");
    assert.equal(persisted.rows[0]!.context_validation_status, "invalid");
    assert.ok(
      persisted.rows[0]!.validation_errors.some(
        (error) => error.code === "ENTITY_PATH_RELATIONSHIP_INVALID"
      )
    );
    assert.equal(await count(pool, "provider_scores"), 0);
  });

  it("rolls back when authoritative PostgreSQL lookup fails and fabricates no result", async () => {
    const fixture = await seedRun(
      pool,
      "openai",
      "gpt-4o-mini",
      ["visibility"]
    );
    const failingDatabase = databaseFailingAuthoritativeLookup(pool);
    await assert.rejects(
      new ProviderExecutionService(
        failingDatabase,
        new ProviderAdapterRegistry([
          new FakeAdapter("openai", "gpt-4o-mini")
        ]),
        500
      ).execute(fixture.jobs[0]!.payload),
      /simulated authoritative lookup failure/
    );
    assert.equal(await count(pool, "provider_results"), 0);
    const job = await pool.query<{ status: string }>(
      "SELECT status FROM provider_jobs WHERE provider_job_id = $1",
      [fixture.jobs[0]!.providerJobId]
    );
    assert.equal(job.rows[0]!.status, "queued");
  });

  for (const level of [
    "domain",
    "category",
    "brand",
    "product",
    "use_context"
  ] as const) {
    it(`loads the authoritative ${level} path`, async () => {
      const fixture = await seedRun(
        pool,
        "openai",
        "gpt-4o-mini",
        ["visibility"]
      );
      if (level !== "domain") {
        await moveFixtureToRelatedPath(
          pool,
          fixture.jobs[0]!.promptJobId,
          level
        );
      }
      const loaded =
        await new AuthoritativeEntityPathContextRepository(
          pool
        ).loadForProviderJob(fixture.jobs[0]!.providerJobId);
      assert.equal(loaded.valid, true);
      if (loaded.valid) {
        assert.equal(loaded.context.targetLevel, level);
        assert.equal(
          loaded.context.canonicalPath.split(" > ").length,
          pathLevelIndex(level) + 1
        );
      }
    });
  }

  for (const [level, relationship] of [
    ["category", "domain_categories"],
    ["brand", "category_brands"],
    ["product", "brand_products"],
    ["use_context", "product_use_contexts"]
  ] as const) {
    it(`rejects a missing ${relationship} relationship`, async () => {
      const fixture = await seedRun(
        pool,
        "openai",
        "gpt-4o-mini",
        ["visibility"]
      );
      const path = await moveFixtureToRelatedPath(
        pool,
        fixture.jobs[0]!.promptJobId,
        level
      );
      await deleteRelationship(pool, relationship, path.relationshipIds);
      const loaded =
        await new AuthoritativeEntityPathContextRepository(
          pool
        ).loadForProviderJob(fixture.jobs[0]!.providerJobId);
      assert.equal(loaded.valid, false);
      if (!loaded.valid) {
        assert.equal(
          loaded.errors[0]!.code,
          "ENTITY_PATH_RELATIONSHIP_INVALID"
        );
      }
    });
  }

  it("rejects inactive taxonomy masters and relationships", async () => {
    const masterFixture = await seedRun(
      pool,
      "openai",
      "gpt-4o-mini",
      ["visibility"]
    );
    const masterPath = await moveFixtureToRelatedPath(
      pool,
      masterFixture.jobs[0]!.promptJobId,
      "category"
    );
    await pool.query(
      "UPDATE categories SET is_active = false WHERE category_id = $1",
      [masterPath.categoryId]
    );
    const inactiveMaster =
      await new AuthoritativeEntityPathContextRepository(
        pool
      ).loadForProviderJob(masterFixture.jobs[0]!.providerJobId);
    assert.equal(inactiveMaster.valid, false);
    if (!inactiveMaster.valid) {
      assert.equal(inactiveMaster.errors[0]!.code, "ENTITY_PATH_ENTITY_INACTIVE");
    }

    await truncatePublicTables(pool);
    const relationshipFixture = await seedRun(
      pool,
      "openai",
      "gpt-4o-mini",
      ["visibility"]
    );
    const relationshipPath = await moveFixtureToRelatedPath(
      pool,
      relationshipFixture.jobs[0]!.promptJobId,
      "category"
    );
    await pool.query(
      `UPDATE domain_categories SET is_active = false
       WHERE domain_category_id = $1`,
      [relationshipPath.relationshipIds.domain_categories]
    );
    const inactiveRelationship =
      await new AuthoritativeEntityPathContextRepository(
        pool
      ).loadForProviderJob(relationshipFixture.jobs[0]!.providerJobId);
    assert.equal(inactiveRelationship.valid, false);
    if (!inactiveRelationship.valid) {
      assert.equal(
        inactiveRelationship.errors[0]!.code,
        "ENTITY_PATH_RELATIONSHIP_INVALID"
      );
    }
  });

  it("feeds real evidence into backend scoring/reporting idempotently", async () => {
    const fixture = await seedRun(pool, "openai", "gpt-4o-mini", [
      "visibility",
      "competitor",
      "ranking",
      "price_range",
      "pros_cons"
    ], true);
    const service = new ProviderExecutionService(
      pool,
      new ProviderAdapterRegistry([
        new FakeAdapter("openai", "gpt-4o-mini")
      ]),
      500
    );
    let reportId: string | null = null;
    for (const job of fixture.jobs) {
      const execution = await service.execute(job.payload);
      assert.equal(execution.outcome, "completed");
      if (execution.outcome !== "completed") continue;
      if (job.promptType === "visibility" || job.promptType === "ranking") {
        const scored = await new ProviderScoreService(pool).process({
          providerResultId: execution.providerResultId
        });
        reportId = scored.reportId ?? reportId;
      }
      assert.equal((await service.execute(job.payload)).outcome, "noop");
    }
    assert.ok(reportId);
    assert.equal(await count(pool, "provider_results"), 5);
    assert.equal(await count(pool, "provider_scores"), 2);
    assert.equal(await count(pool, "token_usage"), 10);
  });
});

class FakeAdapter implements ProviderAdapter {
  calls = 0;
  error: Error | null = null;

  constructor(
    readonly provider: ProviderName,
    private readonly model: string,
    private readonly omitUsage = false
  ) {}

  supportsModel(model: string) {
    return model === this.model;
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderGeneratedOutput> {
    this.calls += 1;
    if (this.error) throw this.error;
    return {
      generatedContent: JSON.stringify(fakeResponse(request)),
      sanitizedProviderMetadata: { fixture: true },
      inputTokens: this.omitUsage ? null : 20,
      outputTokens: this.omitUsage ? null : 10,
      totalTokens: this.omitUsage ? null : 30,
      finishReason: "stop",
      providerRequestId: `${this.provider}-request:${request.providerJobId}`,
      modelVersion: this.model,
      latencyMs: 5
    };
  }
}

function fakeResponse(request: ProviderExecutionRequest) {
  const common = {
    prompt_type: request.promptType,
    contract_version: request.responseContractVersion,
    evidence: [
      {
        claim: "Provider evidence",
        source: `${request.provider}-provider`,
        confidence: 0.6
      }
    ],
    summary: "Provider evidence"
  };
  const result =
    request.promptType === "visibility"
      ? {
          target_mentioned: true,
          mention_likelihood: 0.6,
          recommendation_likelihood: 0.6,
          competitive_prominence: 0.6,
          query_intents: [],
          strengths: [],
          visibility_gaps: [],
          confidence: 0.6
        }
      : request.promptType === "ranking"
        ? {
            requested_top_k:
              request.promptDepth === "weak"
                ? 5
                : request.promptDepth === "medium"
                  ? 10
                  : 20,
            found: true,
            rank_position: 1,
            ordered_candidates: [
              { rank: 1, name: request.exactTargetName }
            ],
            mention_count: 1,
            confidence: 0.6
          }
        : request.promptType === "competitor"
          ? {
              direct_competitors: [],
              indirect_competitors: [],
              target_differentiation: "Fixture differentiation",
              competitive_pressure: 0.5,
              confidence: 0.6
            }
          : request.promptType === "price_range"
            ? {
                applicability: "unknown",
                currency: null,
                minimum: null,
                maximum: null,
                pricing_basis: "Unknown",
                uncertainty: "Fixture",
                confidence: 0.2
              }
            : {
                pros: [],
                cons: [],
                best_fit_for: [],
                poor_fit_for: [],
                comparison_context: "Fixture context",
                confidence: 0.6
              };
  return { ...common, result };
}

async function seedRun(
  pool: pg.Pool,
  provider: Exclude<ProviderName, "mock">,
  model: string,
  promptTypes: PromptType[],
  policyValidPath = false
) {
  const unique = crypto.randomUUID();
  const userId = (
    await pool.query<{ user_id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING user_id",
      [`provider_execution-${unique}@example.com`]
    )
  ).rows[0]!.user_id;
  const workspaceId = (
    await pool.query<{ workspace_id: string }>(
      "INSERT INTO workspaces (workspace_name, created_by_user_id) VALUES ($1, $2) RETURNING workspace_id",
      [`Provider execution ${unique}`, userId]
    )
  ).rows[0]!.workspace_id;
  await pool.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
    [workspaceId, userId]
  );
  const domainId = (
    await pool.query<{ domain_id: string }>(
      "INSERT INTO domains (normalized_domain) VALUES ($1) RETURNING domain_id",
      [`provider-execution-${unique}.example`]
    )
  ).rows[0]!.domain_id;
  let categoryId: string | null = null;
  let brandId: string | null = null;
  let productId: string | null = null;
  const deepPath =
    policyValidPath &&
    promptTypes.some(
      (promptType) =>
        promptType === "price_range" || promptType === "pros_cons"
    );
  if (policyValidPath) {
    categoryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO categories (category_name, normalized_name)
         VALUES ($1, $2) RETURNING category_id AS id`,
        [`Provider category ${unique}`, `provider-category-${unique}`]
      )
    ).rows[0]!.id;
    const domainCategoryId = (
      await pool.query<{ id: string }>(
        `INSERT INTO domain_categories (domain_id, category_id)
         VALUES ($1, $2) RETURNING domain_category_id AS id`,
        [domainId, categoryId]
      )
    ).rows[0]!.id;
    if (deepPath) {
      brandId = (
        await pool.query<{ id: string }>(
          `INSERT INTO brands (brand_name, normalized_name)
           VALUES ($1, $2) RETURNING brand_id AS id`,
          [`Provider brand ${unique}`, `provider-brand-${unique}`]
        )
      ).rows[0]!.id;
      const categoryBrandId = (
        await pool.query<{ id: string }>(
          `INSERT INTO category_brands (domain_category_id, brand_id)
           VALUES ($1, $2) RETURNING category_brand_id AS id`,
          [domainCategoryId, brandId]
        )
      ).rows[0]!.id;
      productId = (
        await pool.query<{ id: string }>(
          `INSERT INTO products (product_name, normalized_name)
           VALUES ($1, $2) RETURNING product_id AS id`,
          [`Provider product ${unique}`, `provider-product-${unique}`]
        )
      ).rows[0]!.id;
      await pool.query(
        `INSERT INTO brand_products (category_brand_id, product_id)
         VALUES ($1, $2)`,
        [categoryBrandId, productId]
      );
    }
  }
  const pathId = (
    await pool.query<{ entity_path_id: string }>(
      `INSERT INTO entity_paths (
         domain_id, category_id, brand_id, product_id, path_type
       ) VALUES (
         $1, $2, $3, $4,
         CASE
           WHEN $4::bigint IS NOT NULL THEN 'product'::entity_path_type
           WHEN $2::bigint IS NOT NULL THEN 'category'::entity_path_type
           ELSE 'domain'::entity_path_type
         END
       ) RETURNING entity_path_id`,
      [domainId, categoryId, brandId, productId]
    )
  ).rows[0]!.entity_path_id;
  const analysisRunId = (
    await pool.query<{ analysis_run_id: string }>(
      `
        INSERT INTO analysis_runs (
          idempotency_key, user_id, workspace_id, starting_entity_path_id,
          category_selection_mode, prompt_depth, prompt_policy_version,
          status, request_payload, started_at
        )
        VALUES (
          $1, $2, $3, $4, 'all', 'high', 'geo-prompt-policy-v1',
          'processing', jsonb_build_object('domain', $5::text), now()
        )
        RETURNING analysis_run_id
      `,
      [
        `provider_execution-run:${unique}`,
        userId,
        workspaceId,
        pathId,
        `provider-execution-${unique}.example`
      ]
    )
  ).rows[0]!.analysis_run_id;
  const modelProfile = providerModelProfile(provider, model);
  assert.ok(modelProfile);
  await pool.query(
    `INSERT INTO analysis_run_provider_models
       (analysis_run_id, provider, model, model_profile_version, ordinal)
     VALUES ($1, $2, $3, $4, 0)`,
    [analysisRunId, provider, model, modelProfile.modelProfileVersion]
  );
  const itemId = (
    await pool.query<{ analysis_run_item_id: string }>(
      `
        INSERT INTO analysis_run_items (
          idempotency_key, analysis_run_id, entity_path_id,
          item_ordinal, status, started_at
        )
        VALUES ($1, $2, $3, 0, 'processing', now())
        RETURNING analysis_run_item_id
      `,
      [`provider_execution-item:${unique}`, analysisRunId, pathId]
    )
  ).rows[0]!.analysis_run_item_id;
  const llmRunId = (
    await pool.query<{ llm_run_id: string }>(
      `
        INSERT INTO llm_runs (
          idempotency_key, analysis_run_item_id, status, started_at
        )
        VALUES ($1, $2, 'processing', now())
        RETURNING llm_run_id
      `,
      [`provider_execution-llm:${unique}`, itemId]
    )
  ).rows[0]!.llm_run_id;
  const jobs = [];
  for (const [index, promptType] of promptTypes.entries()) {
    const promptPolicy = promptTypePolicy(promptType);
    const entityPathContext = {
      domain: {
        id: domainId,
        name: `provider-execution-${unique}.example`
      },
      ...(categoryId
        ? {
            category: {
              id: categoryId,
              name: `Provider category ${unique}`
            }
          }
        : {}),
      ...(brandId
        ? {
            brand: { id: brandId, name: `Provider brand ${unique}` }
          }
        : {}),
      ...(productId
        ? {
            product: {
              id: productId,
              name: `Provider product ${unique}`
            }
          }
        : {}),
      canonicalPath: [
        `provider-execution-${unique}.example`,
        ...(categoryId ? [`Provider category ${unique}`] : []),
        ...(brandId ? [`Provider brand ${unique}`] : []),
        ...(productId ? [`Provider product ${unique}`] : [])
      ].join(" > "),
      startingLevel: productId
        ? ("product" as const)
        : categoryId
          ? ("category" as const)
          : ("domain" as const),
      targetLevel: productId
        ? ("product" as const)
        : categoryId
          ? ("category" as const)
          : ("domain" as const)
    };
    const promptJobId = (
      await pool.query<{ prompt_job_id: string }>(
        `
          INSERT INTO prompt_jobs (
            idempotency_key, llm_run_id, prompt_type, prompt_depth,
            business_prompt_version, response_contract_version,
            status, prompt_text, input_payload, started_at
          )
          VALUES (
            $1, $2, $3, 'high', $4, $5, 'processing', $6, $7, now()
          )
          RETURNING prompt_job_id
        `,
        [
          `provider_execution-prompt:${unique}:${index}`,
          llmRunId,
          promptType,
          promptPolicy.businessPromptVersion,
          promptPolicy.responseContractVersion,
          `Rendered ${promptType} prompt`,
          { entityPathContext }
        ]
      )
    ).rows[0]!.prompt_job_id;
    const providerJobId = (
      await pool.query<{ provider_job_id: string }>(
        `
          INSERT INTO provider_jobs (
            idempotency_key, job_kind, prompt_job_id, provider, model,
            response_contract_version, provider_instruction_profile,
            model_profile_version, structured_output_mode, request_payload,
            status
          )
          VALUES (
            $1, 'normal_prompt', $2, $3, $4, $5, $6, $7, $8, $9, 'queued'
          )
          RETURNING provider_job_id
        `,
        [
          `provider_execution-provider:${unique}:${index}`,
          promptJobId,
          provider,
          model,
          promptPolicy.responseContractVersion,
          modelProfile.providerInstructionProfile,
          modelProfile.modelProfileVersion,
          modelProfile.preferredStructuredOutputMode,
          {
            entityPathContext
          }
        ]
      )
    ).rows[0]!.provider_job_id;
    jobs.push({
      providerJobId,
      promptJobId,
      promptType,
      payload: { providerJobId } as ProviderJobCreatedPayload
    });
  }
  return { analysisRunId, jobs };
}

function providerModels() {
  return [
    ["openai", "gpt-4o-mini"],
    ["gemini", "gemini-1.5-flash"],
    ["claude", "claude-3-5-sonnet"]
  ] as const;
}

async function count(pool: pg.Pool, table: string) {
  if (!new Set(["provider_results", "token_usage", "provider_scores", "reports"]).has(table)) {
    throw new Error("Unsupported count table");
  }
  return Number((await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0]!.count);
}

async function moveFixtureToUnrelatedCategoryPath(
  pool: pg.Pool,
  promptJobId: string
) {
  const lineage = await pool.query<{
    domain_id: string;
    analysis_run_item_id: string;
    normalized_domain: string;
  }>(
    `
      SELECT path.domain_id, item.analysis_run_item_id,
             domain.normalized_domain
      FROM prompt_jobs AS prompt
      JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
      JOIN analysis_run_items AS item
        ON item.analysis_run_item_id = llm.analysis_run_item_id
      JOIN entity_paths AS path ON path.entity_path_id = item.entity_path_id
      JOIN domains AS domain ON domain.domain_id = path.domain_id
      WHERE prompt.prompt_job_id = $1
    `,
    [promptJobId]
  );
  const row = lineage.rows[0]!;
  const categoryId = (
    await pool.query<{ category_id: string }>(
      `INSERT INTO categories (category_name, normalized_name)
       VALUES ('Unrelated', 'unrelated') RETURNING category_id`
    )
  ).rows[0]!.category_id;
  const pathId = (
    await pool.query<{ entity_path_id: string }>(
      `INSERT INTO entity_paths (domain_id, category_id, path_type)
       VALUES ($1, $2, 'category') RETURNING entity_path_id`,
      [row.domain_id, categoryId]
    )
  ).rows[0]!.entity_path_id;
  const context = {
    domain: { id: row.domain_id, name: row.normalized_domain },
    category: { id: categoryId, name: "Unrelated" },
    startingLevel: "domain",
    targetLevel: "category",
    canonicalPath: `${row.normalized_domain} > Unrelated`
  };
  await pool.query(
    "UPDATE analysis_run_items SET entity_path_id = $2 WHERE analysis_run_item_id = $1",
    [row.analysis_run_item_id, pathId]
  );
  await pool.query(
    "UPDATE prompt_jobs SET input_payload = $2 WHERE prompt_job_id = $1",
    [promptJobId, { entityPathContext: context }]
  );
}

function databaseFailingAuthoritativeLookup(pool: pg.Pool) {
  return {
    async connect() {
      const client = await pool.connect();
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return (text: string, values?: unknown[]) => {
              if (
                typeof text === "string" &&
                text.includes("starting_path.path_type AS starting_path_type")
              ) {
                throw new Error("simulated authoritative lookup failure");
              }
              return query(text, values);
            };
          }
          if (property === "release") return release;
          return Reflect.get(target, property, receiver);
        }
      });
    }
  } as pg.Pool;
}

async function moveFixtureToRelatedPath(
  pool: pg.Pool,
  promptJobId: string,
  targetLevel: Exclude<EntityPathType, "domain">
) {
  const lineage = await pool.query<{
    domain_id: string;
    analysis_run_item_id: string;
    normalized_domain: string;
  }>(
    `
      SELECT path.domain_id, item.analysis_run_item_id,
             domain.normalized_domain
      FROM prompt_jobs AS prompt
      JOIN llm_runs AS llm ON llm.llm_run_id = prompt.llm_run_id
      JOIN analysis_run_items AS item
        ON item.analysis_run_item_id = llm.analysis_run_item_id
      JOIN entity_paths AS path ON path.entity_path_id = item.entity_path_id
      JOIN domains AS domain ON domain.domain_id = path.domain_id
      WHERE prompt.prompt_job_id = $1
    `,
    [promptJobId]
  );
  const row = lineage.rows[0]!;
  const categoryId = (
    await pool.query<{ id: string }>(
      `INSERT INTO categories (category_name, normalized_name)
       VALUES ('Analytics', 'analytics') RETURNING category_id AS id`
    )
  ).rows[0]!.id;
  const domainCategoryId = (
    await pool.query<{ id: string }>(
      `INSERT INTO domain_categories (domain_id, category_id)
       VALUES ($1, $2) RETURNING domain_category_id AS id`,
      [row.domain_id, categoryId]
    )
  ).rows[0]!.id;
  const brandId = (
    await pool.query<{ id: string }>(
      `INSERT INTO brands (brand_name, normalized_name)
       VALUES ('Acme', 'acme') RETURNING brand_id AS id`
    )
  ).rows[0]!.id;
  const categoryBrandId = (
    await pool.query<{ id: string }>(
      `INSERT INTO category_brands (domain_category_id, brand_id)
       VALUES ($1, $2) RETURNING category_brand_id AS id`,
      [domainCategoryId, brandId]
    )
  ).rows[0]!.id;
  const productId = (
    await pool.query<{ id: string }>(
      `INSERT INTO products (product_name, normalized_name)
       VALUES ('Observer', 'observer') RETURNING product_id AS id`
    )
  ).rows[0]!.id;
  const brandProductId = (
    await pool.query<{ id: string }>(
      `INSERT INTO brand_products (category_brand_id, product_id)
       VALUES ($1, $2) RETURNING brand_product_id AS id`,
      [categoryBrandId, productId]
    )
  ).rows[0]!.id;
  const useContextId = (
    await pool.query<{ id: string }>(
      `INSERT INTO use_contexts (use_context_name, normalized_name)
       VALUES ('Enterprise monitoring', 'enterprise monitoring')
       RETURNING use_context_id AS id`
    )
  ).rows[0]!.id;
  const productUseContextId = (
    await pool.query<{ id: string }>(
      `INSERT INTO product_use_contexts (brand_product_id, use_context_id)
       VALUES ($1, $2) RETURNING product_use_context_id AS id`,
      [brandProductId, useContextId]
    )
  ).rows[0]!.id;
  const level = pathLevelIndex(targetLevel);
  const ids = [
    row.domain_id,
    level >= 1 ? categoryId : null,
    level >= 2 ? brandId : null,
    level >= 3 ? productId : null,
    level >= 4 ? useContextId : null
  ];
  const pathId = (
    await pool.query<{ id: string }>(
      `
        INSERT INTO entity_paths (
          domain_id, category_id, brand_id, product_id,
          use_context_id, path_type
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING entity_path_id AS id
      `,
      [...ids, targetLevel]
    )
  ).rows[0]!.id;
  const parts = [
    row.normalized_domain,
    "Analytics",
    "Acme",
    "Observer",
    "Enterprise monitoring"
  ].slice(0, level + 1);
  const context: Record<string, unknown> = {
    domain: { id: row.domain_id, name: row.normalized_domain },
    startingLevel: "domain",
    targetLevel,
    canonicalPath: parts.join(" > ")
  };
  if (level >= 1) context.category = { id: categoryId, name: "Analytics" };
  if (level >= 2) context.brand = { id: brandId, name: "Acme" };
  if (level >= 3) context.product = { id: productId, name: "Observer" };
  if (level >= 4) {
    context.useContext = {
      id: useContextId,
      name: "Enterprise monitoring"
    };
  }
  await pool.query(
    "UPDATE analysis_run_items SET entity_path_id = $2 WHERE analysis_run_item_id = $1",
    [row.analysis_run_item_id, pathId]
  );
  await pool.query(
    "UPDATE prompt_jobs SET input_payload = $2 WHERE prompt_job_id = $1",
    [promptJobId, { entityPathContext: context }]
  );
  return {
    categoryId,
    relationshipIds: {
      domain_categories: domainCategoryId,
      category_brands: categoryBrandId,
      brand_products: brandProductId,
      product_use_contexts: productUseContextId
    }
  };
}

async function deleteRelationship(
  pool: pg.Pool,
  table:
    | "domain_categories"
    | "category_brands"
    | "brand_products"
    | "product_use_contexts",
  ids: Record<
    | "domain_categories"
    | "category_brands"
    | "brand_products"
    | "product_use_contexts",
    string
  >
) {
  const primaryKeys = {
    domain_categories: "domain_category_id",
    category_brands: "category_brand_id",
    brand_products: "brand_product_id",
    product_use_contexts: "product_use_context_id"
  } as const;
  const order = [
    "product_use_contexts",
    "brand_products",
    "category_brands",
    "domain_categories"
  ] as const;
  for (const current of order) {
    await pool.query(
      `DELETE FROM ${current} WHERE ${primaryKeys[current]} = $1`,
      [ids[current]]
    );
    if (current === table) break;
  }
}

function pathLevelIndex(level: EntityPathType) {
  return [
    "domain",
    "category",
    "brand",
    "product",
    "use_context"
  ].indexOf(level);
}
