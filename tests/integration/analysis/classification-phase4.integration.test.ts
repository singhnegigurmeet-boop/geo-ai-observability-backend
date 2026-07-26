import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { AnalysisRunExpansionService } from "../../../src/modules/analysis/services/analysis-run-expansion.service.js";
import {
  ClassificationPlanningService,
  PermanentClassificationError
} from "../../../src/modules/analysis/services/classification-planning.service.js";
import { ClassificationResultService } from "../../../src/modules/analysis/services/classification-result.service.js";
import { DomainCategoryClassificationRepository } from "../../../src/modules/analysis/repositories/domain-category-classification.repository.js";
import { resolveClassificationModel } from "../../../src/modules/providers/policies/provider-model.policy.js";
import { ProviderExecutionService } from "../../../src/modules/providers/services/provider-execution.service.js";
import { ProviderExecutionError } from "../../../src/modules/providers/errors/provider-execution.error.js";
import { ProviderAdapterRegistry } from "../../../src/modules/providers/adapters/provider-adapter.registry.js";
import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderGeneratedOutput
} from "../../../src/modules/providers/types/provider-adapter.types.js";
import {
  createIntegrationPool,
  resetTestSchema,
  truncatePublicTables
} from "../../support/integration-environment.js";

const enabled =
  process.env.RUN_CLASSIFICATION_PHASE4_INTEGRATION_TESTS === "true";

describe(
  "Phase 4 classification PostgreSQL integration",
  { skip: !enabled, concurrency: 1 },
  () => {
    let pool: pg.Pool;

    before(async () => {
      pool = createIntegrationPool();
      await resetTestSchema(pool);
    });

    beforeEach(async () => {
      await truncatePublicTables(pool);
    });

    after(async () => pool?.end());

    it("reloads authoritative planning input and persists one frozen provider job", async () => {
      const fixture = await seedClassification(pool);
      const planned = await new ClassificationPlanningService(pool).plan({
        classificationJobId: fixture.classificationJobId
      });
      assert.equal(planned.outcome, "enqueued");
      const state = await planningState(pool, fixture.classificationJobId);
      assert.equal(state.status, "processing");
      assert.ok(state.rendered_prompt.includes("Website hostname: phase4.example"));
      assert.ok(
        state.rendered_prompt.indexOf(`id=${fixture.categoryIds[0]}`) <
          state.rendered_prompt.indexOf(`id=${fixture.categoryIds[1]}`)
      );
      assert.deepEqual(state.request_payload.classificationContext, {
        domain: { id: fixture.domainId, name: "phase4.example" },
        candidates: [
          {
            categoryId: fixture.categoryIds[0],
            categoryName: "Analytics"
          },
          {
            categoryId: fixture.categoryIds[1],
            categoryName: "Monitoring"
          }
        ]
      });
      assert.equal(await count(pool, "provider_jobs"), 1);
      assert.equal(
        await eventCount(pool, "provider_job.created", state.provider_job_id),
        1
      );
    });

    it("rejects a tampered frozen JSON snapshot and never sends its candidate list", async () => {
      const fixture = await seedClassification(pool);
      await pool.query(
        "ALTER TABLE domain_category_classification_jobs DISABLE TRIGGER domain_category_classification_jobs_identity_trigger"
      );
      try {
        await pool.query(
          `UPDATE domain_category_classification_jobs
           SET input_payload =
             jsonb_set(input_payload, '{candidates,0,categoryName}',
                       '"Injected category"'::jsonb)
           WHERE domain_category_classification_job_id = $1`,
          [fixture.classificationJobId]
        );
      } finally {
        await pool.query(
          "ALTER TABLE domain_category_classification_jobs ENABLE TRIGGER domain_category_classification_jobs_identity_trigger"
        );
      }
      await assert.rejects(
        new ClassificationPlanningService(pool).plan({
          classificationJobId: fixture.classificationJobId
        }),
        (error) =>
          error instanceof PermanentClassificationError &&
          error.code === "CLASSIFICATION_INPUT_SNAPSHOT_MISMATCH"
      );
      assert.equal(await count(pool, "provider_jobs"), 0);
      assert.equal(await eventCount(pool, "provider_job.created"), 0);
    });

    it("serializes duplicate creation and planning into one job, provider job, and event", async () => {
      const fixture = await seedBaseRun(pool);
      const expansion = new AnalysisRunExpansionService(pool);
      const outcomes = await Promise.all([
        expansion.expand({ analysisRunId: fixture.analysisRunId }),
        expansion.expand({ analysisRunId: fixture.analysisRunId })
      ]);
      assert.ok(
        outcomes.every(
          (outcome) => outcome.outcome === "classification_pending"
        )
      );
      const classificationJobId = await singleClassificationJobId(
        pool,
        fixture.analysisRunId
      );
      const planning = new ClassificationPlanningService(pool);
      const planned = await Promise.all([
        planning.plan({ classificationJobId }),
        planning.plan({ classificationJobId })
      ]);
      assert.deepEqual(
        planned.map((outcome) => outcome.outcome).sort(),
        ["enqueued", "noop"]
      );
      assert.equal(await count(pool, "domain_category_classification_jobs"), 1);
      assert.equal(await count(pool, "provider_jobs"), 1);
      const providerJobId = (
        await pool.query<{ provider_job_id: string }>(
          "SELECT provider_job_id FROM provider_jobs"
        )
      ).rows[0]!.provider_job_id;
      assert.equal(
        await eventCount(pool, "provider_job.created", providerJobId),
        1
      );
    });

    it("protects the logical decision and immutable complete execution identity", async () => {
      const fixture = await seedClassification(pool);
      await assert.rejects(
        new DomainCategoryClassificationRepository(pool).createOrReuse({
          analysisRunId: fixture.analysisRunId,
          domainId: fixture.domainId,
          normalizedDomain: "phase4.example",
          candidates: [
            {
              categoryId: fixture.categoryIds[0],
              categoryName: "Analytics"
            },
            {
              categoryId: fixture.categoryIds[1],
              categoryName: "Monitoring"
            }
          ],
          classifier: resolveClassificationModel({
            provider: "mock",
            model: "mock-standard",
            realProvidersEnabled: false
          })
        }),
        /different frozen execution identity/
      );
      await assert.rejects(
        pool.query(
          `UPDATE domain_category_classification_jobs
           SET prompt_version = 'rewritten-v2'
           WHERE domain_category_classification_job_id = $1`,
          [fixture.classificationJobId]
        ),
        hasCode("23514")
      );
    });

    it("reactivates an inactive relationship with current classification provenance", async () => {
      const fixture = await seedPlannedClassification(pool);
      await pool.query(
        `INSERT INTO domain_categories (
           domain_id, category_id, is_active, source
         )
         VALUES ($1, $2, false, 'manual')`,
        [fixture.domainId, fixture.categoryIds[0]]
      );
      const resultId = await seedProviderResult(pool, fixture, [
        match(fixture.categoryIds[0], 1, 0.91)
      ]);
      const outcome = await new ClassificationResultService(pool).process({
        providerResultId: resultId
      });
      assert.equal(outcome.outcome, "completed");
      assert.equal(outcome.relationshipCount, 1);
      assert.deepEqual(outcome.counts, {
        returnedMatchCount: 1,
        newlyCreatedCount: 0,
        reactivatedCount: 1,
        concurrentlyReusedCount: 0,
        existingReusedCount: 0,
        acceptedActiveCount: 1
      });
      const relationship = await relationshipFor(
        pool,
        fixture.domainId,
        fixture.categoryIds[0]
      );
      assert.equal(relationship.is_active, true);
      assert.equal(relationship.source, "llm_classification");
      assert.equal(relationship.classification_provider_result_id, resultId);
      assert.equal(relationship.classification_rank, 1);
      assert.equal(Number(relationship.classification_confidence), 0.91);
      assert.ok(relationship.classified_at);
    });

    it("creates one active LLM relationship and reports database-truth counts", async () => {
      const fixture = await seedPlannedClassification(pool);
      const resultId = await seedProviderResult(pool, fixture, [
        match(fixture.categoryIds[0], 1, 0.93)
      ]);
      const outcome = await new ClassificationResultService(pool).process({
        providerResultId: resultId
      });
      assert.equal(outcome.outcome, "completed");
      assert.deepEqual(outcome.counts, {
        returnedMatchCount: 1,
        newlyCreatedCount: 1,
        reactivatedCount: 0,
        concurrentlyReusedCount: 0,
        existingReusedCount: 0,
        acceptedActiveCount: 1
      });
      const relationship = await relationshipFor(
        pool,
        fixture.domainId,
        fixture.categoryIds[0]
      );
      assert.equal(relationship.is_active, true);
      assert.equal(relationship.source, "llm_classification");
      assert.equal(relationship.classification_provider_result_id, resultId);
    });

    it("reuses an active manual relationship without overwriting provenance", async () => {
      const fixture = await seedPlannedClassification(pool);
      await pool.query(
        `INSERT INTO domain_categories (
           domain_id, category_id, is_active, source, sort_order
         )
         VALUES ($1, $2, true, 'manual', 7)`,
        [fixture.domainId, fixture.categoryIds[0]]
      );
      const resultId = await seedProviderResult(pool, fixture, [
        match(fixture.categoryIds[0], 1, 0.87)
      ]);
      const outcome = await new ClassificationResultService(pool).process({
        providerResultId: resultId
      });
      assert.equal(outcome.outcome, "completed");
      assert.equal(outcome.counts.existingReusedCount, 1);
      assert.equal(outcome.counts.acceptedActiveCount, 1);
      const relationship = await relationshipFor(
        pool,
        fixture.domainId,
        fixture.categoryIds[0]
      );
      assert.equal(relationship.source, "manual");
      assert.equal(relationship.classification_provider_result_id, null);
      assert.equal(relationship.classification_rank, null);
      assert.equal(relationship.classification_confidence, null);
      assert.equal(relationship.classified_at, null);
    });

    it("preserves active import and prior LLM provenance on reuse", async () => {
      for (const source of ["import", "llm_classification"] as const) {
        const fixture = await seedPlannedClassification(pool);
        const currentResultId = await seedProviderResult(pool, fixture, [
          match(fixture.categoryIds[0], 1, 0.99)
        ]);
        const priorResultId =
          source === "llm_classification" ? currentResultId : null;
        await pool.query(
          `INSERT INTO domain_categories (
             domain_id, category_id, is_active, source,
             classification_provider_result_id, classification_rank,
             classification_confidence, classified_at
           )
           VALUES (
             $1, $2, true, $3, $4,
             CASE WHEN $3 = 'llm_classification' THEN 4 ELSE NULL END,
             CASE WHEN $3 = 'llm_classification' THEN 0.42 ELSE NULL END,
             CASE WHEN $3 = 'llm_classification' THEN now() ELSE NULL END
           )`,
          [fixture.domainId, fixture.categoryIds[0], source, priorResultId]
        );
        const outcome = await new ClassificationResultService(pool).process({
          providerResultId: currentResultId
        });
        assert.equal(outcome.outcome, "completed");
        assert.equal(outcome.counts.existingReusedCount, 1);
        const relationship = await relationshipFor(
          pool,
          fixture.domainId,
          fixture.categoryIds[0]
        );
        assert.equal(relationship.source, source);
        assert.equal(
          relationship.classification_provider_result_id,
          priorResultId
        );
        if (source === "llm_classification") {
          assert.equal(relationship.classification_rank, 4);
          assert.equal(
            Number(relationship.classification_confidence),
            0.42
          );
        }
        await truncatePublicTables(pool);
      }
    });

    it("makes concurrent duplicate result delivery idempotent", async () => {
      const fixture = await seedPlannedClassification(pool);
      const resultId = await seedProviderResult(pool, fixture, [
        match(fixture.categoryIds[0], 1, 0.8)
      ]);
      const outcomes = await Promise.all([
        new ClassificationResultService(pool).process({
          providerResultId: resultId
        }),
        new ClassificationResultService(pool).process({
          providerResultId: resultId
        })
      ]);
      assert.deepEqual(
        outcomes.map((outcome) => outcome.outcome).sort(),
        ["completed", "noop"]
      );
      assert.equal(await count(pool, "domain_categories"), 1);
      assert.equal(
        await eventCount(
          pool,
          "analysis_run.created",
          fixture.analysisRunId,
          "analysis_run.classification_completed:"
        ),
        1
      );
    });

    it("preserves zero-match and invalid out-of-candidate outcomes", async () => {
      const empty = await seedPlannedClassification(pool);
      const emptyResultId = await seedProviderResult(pool, empty, []);
      const emptyOutcome = await new ClassificationResultService(pool).process({
        providerResultId: emptyResultId
      });
      assert.equal(emptyOutcome.outcome, "completed_empty");
      assert.equal(emptyOutcome.relationshipCount, 0);
      assert.equal(await count(pool, "domain_categories"), 0);

      await truncatePublicTables(pool);
      const invalid = await seedPlannedClassification(pool);
      const invalidResultId = await seedProviderResult(pool, invalid, [
        match("999999", 1, 0.5)
      ]);
      const invalidOutcome = await new ClassificationResultService(pool).process({
        providerResultId: invalidResultId
      });
      assert.equal(invalidOutcome.outcome, "invalid");
      assert.equal(invalidOutcome.relationshipCount, 0);
      assert.equal(await count(pool, "domain_categories"), 0);
      const status = await pool.query<{ status: string }>(
        `SELECT status FROM domain_category_classification_jobs
         WHERE domain_category_classification_job_id = $1`,
        [invalid.classificationJobId]
      );
      assert.equal(status.rows[0]!.status, "invalid");
    });

    it("never accepts an inactive category master", async () => {
      const fixture = await seedPlannedClassification(pool);
      await pool.query(
        "UPDATE categories SET is_active = false WHERE category_id = $1",
        [fixture.categoryIds[0]]
      );
      const resultId = await seedProviderResult(pool, fixture, [
        match(fixture.categoryIds[0], 1, 0.75)
      ]);
      const outcome = await new ClassificationResultService(pool).process({
        providerResultId: resultId
      });
      assert.equal(outcome.outcome, "invalid");
      assert.equal(await count(pool, "domain_categories"), 0);
    });

    it("fails closed before provider execution when a frozen category becomes inactive", async () => {
      const fixture = await seedPlannedClassification(pool);
      await pool.query(
        "UPDATE categories SET is_active = false WHERE category_id = $1",
        [fixture.categoryIds[0]]
      );
      const providerJobId = (
        await pool.query<{ id: string }>(
          `SELECT provider_job_id AS id FROM provider_jobs
           WHERE classification_job_id = $1`,
          [fixture.classificationJobId]
        )
      ).rows[0]!.id;
      const adapter = new CountingClassificationAdapter();
      await assert.rejects(
        new ProviderExecutionService(
          pool,
          new ProviderAdapterRegistry([adapter]),
          500
        ).execute({ providerJobId }),
        (error) =>
          error instanceof ProviderExecutionError &&
          error.code === "CLASSIFICATION_CATEGORY_INACTIVE"
      );
      assert.equal(adapter.calls, 0);
      assert.equal(await count(pool, "provider_results"), 0);
    });
  }
);

type Fixture = Awaited<ReturnType<typeof seedClassification>>;

async function seedBaseRun(pool: pg.Pool) {
  const domainId = (
    await pool.query<{ id: string }>(
      `INSERT INTO domains (normalized_domain)
       VALUES ('phase4.example') RETURNING domain_id AS id`
    )
  ).rows[0]!.id;
  const categoryIds: string[] = [];
  for (const [name, normalized] of [
    ["Analytics", "analytics"],
    ["Monitoring", "monitoring"]
  ]) {
    categoryIds.push(
      (
        await pool.query<{ id: string }>(
          `INSERT INTO categories (category_name, normalized_name)
           VALUES ($1, $2) RETURNING category_id AS id`,
          [name, normalized]
        )
      ).rows[0]!.id
    );
  }
  const pathId = (
    await pool.query<{ id: string }>(
      `INSERT INTO entity_paths (domain_id, path_type)
       VALUES ($1, 'domain') RETURNING entity_path_id AS id`,
      [domainId]
    )
  ).rows[0]!.id;
  const sessionId = (
    await pool.query<{ id: string }>(
      `INSERT INTO anonymous_sessions (token_hash, expires_at)
       VALUES ($1, now() + interval '1 day')
       RETURNING anonymous_session_id AS id`,
      [crypto.randomUUID()]
    )
  ).rows[0]!.id;
  const analysisRunId = (
    await pool.query<{ id: string }>(
      `INSERT INTO analysis_runs (
         idempotency_key, anonymous_session_id, starting_entity_path_id,
         category_selection_mode, prompt_depth, prompt_policy_version,
         request_payload
       )
       VALUES ($1, $2, $3, 'selected', 'weak',
               'geo-prompt-policy-v1',
               jsonb_build_object('domain', 'phase4.example'))
       RETURNING analysis_run_id AS id`,
      [crypto.randomUUID(), sessionId, pathId]
    )
  ).rows[0]!.id;
  for (const [ordinal, categoryId] of categoryIds.entries()) {
    await pool.query(
      `INSERT INTO analysis_run_requested_categories (
         analysis_run_id, category_id, ordinal
       ) VALUES ($1, $2, $3)`,
      [analysisRunId, categoryId, ordinal]
    );
  }
  return { analysisRunId, domainId, categoryIds };
}

async function seedClassification(pool: pg.Pool) {
  const fixture = await seedBaseRun(pool);
  assert.deepEqual(
    await new AnalysisRunExpansionService(pool).expand({
      analysisRunId: fixture.analysisRunId
    }),
    { outcome: "classification_pending", itemCount: 0 }
  );
  return {
    ...fixture,
    classificationJobId: await singleClassificationJobId(
      pool,
      fixture.analysisRunId
    )
  };
}

async function seedPlannedClassification(pool: pg.Pool) {
  const fixture = await seedClassification(pool);
  const planned = await new ClassificationPlanningService(pool).plan({
    classificationJobId: fixture.classificationJobId
  });
  assert.equal(planned.outcome, "enqueued");
  return fixture;
}

async function seedProviderResult(
  pool: pg.Pool,
  fixture: Fixture,
  matches: Array<ReturnType<typeof match>>
) {
  const providerJob = (
    await pool.query<{
      provider_job_id: string;
      provider: string;
      model: string;
      response_contract_version: string;
    }>(
      `UPDATE provider_jobs
       SET status = 'succeeded',
           started_at = COALESCE(started_at, now()),
           completed_at = now()
       WHERE classification_job_id = $1
       RETURNING provider_job_id, provider, model,
                 response_contract_version`,
      [fixture.classificationJobId]
    )
  ).rows[0]!;
  const response = {
    prompt_type: "domain_category_classification",
    contract_version: providerJob.response_contract_version,
    matches,
    summary: matches.length ? "Accepted matches" : "No matches"
  };
  const raw = JSON.stringify(response);
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO provider_results (
         idempotency_key, provider_job_id, provider, status,
         response_contract_version, model_version, raw_response,
         raw_response_original_bytes, provider_metadata,
         validated_response, validation_errors,
         context_validation_status, latency_ms, received_at
       )
       VALUES (
         $1, $2, $3, 'valid', $4, $5, $6, octet_length($6),
         '{}'::jsonb, $7, '[]'::jsonb, 'valid', 0, now()
       )
       RETURNING provider_result_id AS id`,
      [
        `classification-result:${providerJob.provider_job_id}`,
        providerJob.provider_job_id,
        providerJob.provider,
        providerJob.response_contract_version,
        providerJob.model,
        raw,
        response
      ]
    )
  ).rows[0]!.id;
}

function match(categoryId: string, rank: number, confidence: number) {
  return {
    category_id: categoryId,
    rank,
    confidence,
    reason: "Authoritative test match"
  };
}

async function singleClassificationJobId(
  pool: pg.Pool,
  analysisRunId: string
) {
  return (
    await pool.query<{ id: string }>(
      `SELECT domain_category_classification_job_id AS id
       FROM domain_category_classification_jobs
       WHERE analysis_run_id = $1`,
      [analysisRunId]
    )
  ).rows[0]!.id;
}

async function planningState(pool: pg.Pool, classificationJobId: string) {
  return (
    await pool.query<{
      status: string;
      rendered_prompt: string;
      provider_job_id: string;
      request_payload: {
        classificationContext: unknown;
      };
    }>(
      `SELECT classification.status, classification.rendered_prompt,
              job.provider_job_id, job.request_payload
       FROM domain_category_classification_jobs AS classification
       JOIN provider_jobs AS job
         ON job.classification_job_id =
            classification.domain_category_classification_job_id
       WHERE classification.domain_category_classification_job_id = $1`,
      [classificationJobId]
    )
  ).rows[0]!;
}

async function relationshipFor(
  pool: pg.Pool,
  domainId: string,
  categoryId: string
) {
  return (
    await pool.query<{
      is_active: boolean;
      source: string;
      classification_provider_result_id: string | null;
      classification_rank: number | null;
      classification_confidence: string | null;
      classified_at: Date | null;
    }>(
      `SELECT * FROM domain_categories
       WHERE domain_id = $1 AND category_id = $2`,
      [domainId, categoryId]
    )
  ).rows[0]!;
}

async function count(pool: pg.Pool, table: string) {
  return Number(
    (await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`))
      .rows[0]!.count
  );
}

async function eventCount(
  pool: pg.Pool,
  eventType: string,
  aggregateId?: string,
  eventKeyPrefix?: string
) {
  return Number(
    (
      await pool.query<{ count: string }>(
        `SELECT count(*) FROM outbox_events
         WHERE event_type = $1
           AND ($2::text IS NULL OR aggregate_id = $2)
           AND ($3::text IS NULL OR event_key LIKE $3 || '%')`,
        [eventType, aggregateId ?? null, eventKeyPrefix ?? null]
      )
    ).rows[0]!.count
  );
}

function hasCode(code: string) {
  return (error: unknown) =>
    Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === code
    );
}

class CountingClassificationAdapter implements ProviderAdapter {
  readonly provider = "mock" as const;
  calls = 0;

  supportsModel(model: string) {
    return model === "mock-fast";
  }

  async execute(
    _request: ProviderExecutionRequest
  ): Promise<ProviderGeneratedOutput> {
    this.calls += 1;
    throw new Error("Adapter must not execute for an inactive candidate");
  }
}
