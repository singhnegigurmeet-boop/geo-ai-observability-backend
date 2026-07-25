import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { ProviderAdapterRegistry } from "../src/providers/provider-adapter.registry.js";
import type {
  ProviderAdapter,
  ProviderExecutionRequest,
  ProviderExecutionResult
} from "../src/providers/provider-adapter.types.js";
import { ProviderExecutionError } from "../src/providers/provider-execution.error.js";
import { ProviderExecutionService } from "../src/providers/provider-execution.service.js";
import type { ProviderJobCreatedPayload } from "../src/providers/provider-worker.messages.js";
import { ProviderScoreService } from "../src/scoring/provider-score.service.js";
import type { PromptType, ProviderName } from "../src/types/database.types.js";
import {
  createIntegrationPool,
  resetTestSchema,
  truncatePublicTables
} from "./support/integration-environment.js";

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
      ["visibility"]
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
        validation_errors: ["evidence must be an array"],
        job_status: "failed"
      }
    ]);
    assert.equal(await count(pool, "provider_scores"), 0);
    const report = await pool.query<{ lifecycle_state: string }>(
      `SELECT report_data->>'lifecycleState' AS lifecycle_state
       FROM reports WHERE analysis_run_id = $1`,
      [fixture.analysisRunId]
    );
    assert.deepEqual(report.rows, [{ lifecycle_state: "failed_empty" }]);
  });

  it("feeds real evidence into backend scoring/reporting idempotently", async () => {
    const fixture = await seedRun(pool, "openai", "gpt-4o-mini", [
      "visibility",
      "competitor",
      "ranking",
      "price_range",
      "pros_cons"
    ]);
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
      const scored = await new ProviderScoreService(pool).process({
        providerResultId: execution.providerResultId,
        providerJobId: job.providerJobId,
        promptJobId: job.promptJobId,
        analysisRunId: fixture.analysisRunId
      });
      reportId = scored.reportId ?? reportId;
      assert.equal((await service.execute(job.payload)).outcome, "noop");
    }
    assert.ok(reportId);
    assert.equal(await count(pool, "provider_results"), 5);
    assert.equal(await count(pool, "provider_scores"), 5);
    assert.equal(await count(pool, "reports"), 5);
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

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    this.calls += 1;
    if (this.error) throw this.error;
    return {
      rawResponse: {
        id: `${this.provider}-request:${request.providerJobId}`,
        text: "Provider evidence"
      },
      parsedEvidence: {
        provider: this.provider,
        model: this.model,
        evidence: [
          { claim: "Provider evidence", source: `${this.provider}-provider`, confidence: 0.6 }
        ]
      },
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

async function seedRun(
  pool: pg.Pool,
  provider: Exclude<ProviderName, "mock">,
  model: string,
  promptTypes: PromptType[]
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
  const pathId = (
    await pool.query<{ entity_path_id: string }>(
      "INSERT INTO entity_paths (domain_id, path_type) VALUES ($1, 'domain') RETURNING entity_path_id",
      [domainId]
    )
  ).rows[0]!.entity_path_id;
  const analysisRunId = (
    await pool.query<{ analysis_run_id: string }>(
      `
        INSERT INTO analysis_runs (
          idempotency_key, user_id, workspace_id, starting_entity_path_id,
          status, request_payload, started_at
        )
        VALUES ($1, $2, $3, $4, 'processing', '{}'::jsonb, now())
        RETURNING analysis_run_id
      `,
      [`provider_execution-run:${unique}`, userId, workspaceId, pathId]
    )
  ).rows[0]!.analysis_run_id;
  await pool.query(
    `INSERT INTO analysis_run_provider_models
       (analysis_run_id, provider, model, ordinal)
     VALUES ($1, $2, $3, 0)`,
    [analysisRunId, provider, model]
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
    const promptJobId = (
      await pool.query<{ prompt_job_id: string }>(
        `
          INSERT INTO prompt_jobs (
            idempotency_key, llm_run_id, prompt_type, prompt_version,
            status, prompt_text, started_at
          )
          VALUES ($1, $2, $3, 'v1', 'processing', $4, now())
          RETURNING prompt_job_id
        `,
        [`provider_execution-prompt:${unique}:${index}`, llmRunId, promptType, `Rendered ${promptType} prompt`]
      )
    ).rows[0]!.prompt_job_id;
    const providerJobId = (
      await pool.query<{ provider_job_id: string }>(
        `
          INSERT INTO provider_jobs (
            idempotency_key, prompt_job_id, provider, model, status
          )
          VALUES ($1, $2, $3, $4, 'queued')
          RETURNING provider_job_id
        `,
        [`provider_execution-provider:${unique}:${index}`, promptJobId, provider, model]
      )
    ).rows[0]!.provider_job_id;
    jobs.push({
      providerJobId,
      promptJobId,
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
