import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { AnalysisRunExpansionService } from "../../../src/modules/analysis/services/analysis-run-expansion.service.js";
import { AnalysisRunWorker } from "../../../src/modules/analysis/workers/analysis-run-worker.js";
import type { AnalysisRunCreatedPayload } from "../../../src/modules/analysis/messages/analysis-run-worker.messages.js";
import { getDefaultMigrationsDirectory, runMigrations } from "../../../src/common/database/migration-runner.js";
import { deadLetterQueueName } from "../../../src/common/messaging/queue-names.js";
import { RabbitMqConnection } from "../../../src/common/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../../../src/common/messaging/rabbitmq.topology.js";
import { FailureRecordRepository } from "../../../src/modules/reliability/repositories/failure-record.repository.js";
import { AnalysisRunWorkerRuntime } from "../../../src/modules/analysis/runtime/analysis-run-worker.runtime.js";
import type { EntityPathType } from "../../../src/common/types/database.types.js";

const enabled = process.env.RUN_EXPANSION_RELIABILITY_INTEGRATION_TESTS === "true";

describe(
    "Analysis expansion reliability integration",
  { skip: !enabled, concurrency: 1 },
  () => {
  let pool: pg.Pool;
  let rabbitMq: RabbitMqConnection;

  before(async () => {
    pool = new pg.Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test",
      max: 8
    });
    const database = await pool.query<{ name: string }>(
      "SELECT current_database() AS name"
    );
    if (!database.rows[0]?.name.endsWith("_test")) {
      throw new Error("Refusing to reset a non-test database");
    }
    await pool.query("DROP SCHEMA IF EXISTS geo_meta CASCADE");
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations({ pool, migrationsDirectory: getDefaultMigrationsDirectory() });
    rabbitMq = new RabbitMqConnection({
      url:
        process.env.TEST_RABBITMQ_URL ??
        "amqp://guest:guest@127.0.0.1:5673?heartbeat=10",
      initializeChannel: (channel) =>
        declareRabbitMqTopology(channel, {
          mainExchange: "geo.v6.test.main",
          deadLetterExchange: "geo.v6.test.dlx"
        })
    });
    await rabbitMq.getConfirmChannel();
  });

  beforeEach(async () => {
    const tables = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    await pool.query(
      `TRUNCATE ${tables.rows.map((row) => `"${row.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
    const channel = await rabbitMq.getConfirmChannel();
    await channel.purgeQueue("analysis_run_queue");
    await channel.purgeQueue(deadLetterQueueName("analysis_run_queue"));
  });

  after(async () => {
    await rabbitMq?.close();
    await pool?.end();
  });

  it("expands anonymous domain runs to the deterministic top three and is idempotent", async () => {
    const fixture = await seedHierarchy(pool, 6);
    const owner = await anonymousOwner(pool);
    const run = await createRun(pool, fixture.paths.domain, owner);
    const beforeMasters = await masterCounts(pool);
    const service = new AnalysisRunExpansionService(pool);

    assert.deepEqual(await service.expand(payload(run)), {
      outcome: "expanded",
      itemCount: 3
    });
    const items = await runItems(pool, run.runId);
    assert.deepEqual(items.map((item) => item.item_ordinal), [0, 1, 2]);
    assert.deepEqual(
      items.map((item) => item.category_id),
      [fixture.categories[1], fixture.categories[0], fixture.categories[3]]
    );
    assert.ok(items.every((item) => item.status === "queued"));
    assert.equal((await runState(pool, run.runId)).status, "processing");
    assert.ok((await runState(pool, run.runId)).started_at);
    assert.deepEqual(await masterCounts(pool), beforeMasters);

    assert.deepEqual(await service.expand(payload(run)), {
      outcome: "noop",
      itemCount: 0
    });
    assert.equal((await runItems(pool, run.runId)).length, 3);
    assert.equal(await itemOutboxCount(pool, run.runId), 3);
    await assertIdOnlyEvents(pool, run.runId);
  });

  it("uses top five for logged-in and claimed runs while preserving claim origin", async () => {
    const fixture = await seedHierarchy(pool, 6);
    const user = await userOwner(pool);
    const userRun = await createRun(pool, fixture.paths.domain, user);
    assert.equal(
      (await new AnalysisRunExpansionService(pool).expand(payload(userRun))).itemCount,
      5
    );

    const claimed = await claimedOwner(pool);
    const claimedRun = await createRun(pool, fixture.paths.domain, claimed);
    assert.equal(
      (await new AnalysisRunExpansionService(pool).expand(payload(claimedRun))).itemCount,
      5
    );
    const events = await pool.query<{ payload: Record<string, unknown> }>(
      `
        SELECT event.payload
        FROM outbox_events AS event
        JOIN analysis_run_items AS item
          ON item.analysis_run_item_id = event.aggregate_id::bigint
        WHERE item.analysis_run_id = $1
          AND event.event_type = 'analysis_run_item.created'
      `,
      [claimedRun.runId]
    );
    assert.ok(
      events.rows.every(
        ({ payload: event }) =>
          Object.keys(event).length === 1 &&
          typeof event.analysisRunItemId === "string"
      )
    );
    const ownership = await pool.query<{
      user_id: string;
      workspace_id: string;
      anonymous_session_id: string;
    }>(
      `SELECT user_id, workspace_id, anonymous_session_id
       FROM analysis_runs WHERE analysis_run_id = $1`,
      [claimedRun.runId]
    );
    assert.equal(ownership.rows[0]?.user_id, claimed.userId);
    assert.equal(ownership.rows[0]?.workspace_id, claimed.workspaceId);
    assert.equal(
      ownership.rows[0]?.anonymous_session_id,
      claimed.anonymousSessionId
    );
  });

  it("expands category, brand, product, and full paths exactly one level", async () => {
    const fixture = await seedHierarchy(pool, 4);
    const owner = await anonymousOwner(pool);
    const cases: Array<[string, number, EntityPathType]> = [
      [fixture.paths.category, 3, "brand"],
      [fixture.paths.brand, 3, "product"],
      [fixture.paths.product, 3, "use_context"],
      [fixture.paths.useContext, 1, "use_context"]
    ];
    for (const [pathId, expected, expectedType] of cases) {
      const run = await createRun(pool, pathId, owner);
      const result = await new AnalysisRunExpansionService(pool).expand(
        payload(run)
      );
      assert.equal(result.itemCount, expected);
      const items = await runItems(pool, run.runId);
      assert.equal(items.length, expected);
      assert.ok(items.every((item) => item.path_type === expectedType));
    }
  });

  it("excludes inactive relationships and does not infer children from entity_paths", async () => {
    const fixture = await seedHierarchy(pool, 1);
    const phantomCategory = await master(pool, "categories", "category", "phantom");
    await entityPath(pool, {
      domainId: fixture.domainId,
      categoryId: phantomCategory,
      pathType: "category"
    });
    await pool.query("UPDATE domain_categories SET is_active = false");
    const owner = await anonymousOwner(pool);
    const run = await createRun(pool, fixture.paths.domain, owner);

    assert.deepEqual(
      await new AnalysisRunExpansionService(pool).expand(payload(run)),
      { outcome: "empty", itemCount: 0 }
    );
    const state = await runState(pool, run.runId);
    assert.equal(state.status, "completed");
    assert.equal(state.error_code, null);
    assert.ok(state.started_at);
    assert.ok(state.completed_at);
    assert.equal((await runItems(pool, run.runId)).length, 0);
    assert.equal(await itemOutboxCount(pool, run.runId), 0);
    const emptyReport = await pool.query<{
      status: string;
      lifecycle_state: string;
      target_count: number;
    }>(
      `SELECT status,
              report_data->>'lifecycleState' AS lifecycle_state,
              (report_data->>'expandedTargetCount')::integer AS target_count
       FROM reports WHERE analysis_run_id = $1`,
      [run.runId]
    );
    assert.deepEqual(emptyReport.rows, [
      {
        status: "completed",
        lifecycle_state: "completed_empty",
        target_count: 0
      }
    ]);
    assert.equal(await countFailureRecords(pool), 0);
    assert.deepEqual(
      await new AnalysisRunExpansionService(pool).expand(payload(run)),
      { outcome: "noop", itemCount: 0 }
    );
  });

  it("reuses child paths without mutating the starting path", async () => {
    const fixture = await seedHierarchy(pool, 3);
    const existing = await entityPath(pool, {
      domainId: fixture.domainId,
      categoryId: fixture.categories[1]!,
      pathType: "category"
    });
    const before = await pool.query(
      "SELECT * FROM entity_paths WHERE entity_path_id = $1",
      [fixture.paths.domain]
    );
    const owner = await anonymousOwner(pool);
    const run = await createRun(pool, fixture.paths.domain, owner);
    await new AnalysisRunExpansionService(pool).expand(payload(run));
    const items = await runItems(pool, run.runId);
    assert.equal(items[0]?.entity_path_id, existing);
    const after = await pool.query(
      "SELECT * FROM entity_paths WHERE entity_path_id = $1",
      [fixture.paths.domain]
    );
    assert.deepEqual(after.rows, before.rows);
  });

  it("rolls technical failures back and leaves the run queued", async () => {
    const fixture = await seedHierarchy(pool, 2);
    const owner = await anonymousOwner(pool);
    const run = await createRun(pool, fixture.paths.domain, owner);
    await pool.query(`
      CREATE FUNCTION expansion_test_outbox_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test outbox failure'; END $$;
      CREATE TRIGGER expansion_test_outbox_failure_trigger
      BEFORE INSERT ON outbox_events FOR EACH ROW
      WHEN (NEW.event_type = 'analysis_run_item.created')
      EXECUTE FUNCTION expansion_test_outbox_failure()
    `);
    await assert.rejects(
      new AnalysisRunExpansionService(pool).expand(payload(run)),
      /test outbox failure/
    );
    assert.equal((await runState(pool, run.runId)).status, "queued");
    assert.equal((await runItems(pool, run.runId)).length, 0);
    assert.equal(await itemOutboxCount(pool, run.runId), 0);
    await pool.query(`
      DROP TRIGGER expansion_test_outbox_failure_trigger ON outbox_events;
      DROP FUNCTION expansion_test_outbox_failure()
    `);
  });

  it("does not create downstream execution records", async () => {
    const fixture = await seedHierarchy(pool, 1);
    const owner = await anonymousOwner(pool);
    const run = await createRun(pool, fixture.paths.domain, owner);
    await new AnalysisRunExpansionService(pool).expand(payload(run));
    for (const table of [
      "llm_runs",
      "prompt_jobs",
      "provider_jobs",
      "provider_results",
      "token_usage",
      "provider_scores",
      "reports",
      "scheduler_jobs",
      "notifications"
    ]) {
      const count = await pool.query<{ count: string }>(
        `SELECT count(*) FROM ${table}`
      );
      assert.equal(count.rows[0]?.count, "0", table);
    }
  });

  it("consumes live RabbitMQ messages and exhausts technical retries into the existing DLQ", async () => {
    const fixture = await seedHierarchy(pool, 2);
    const owner = await anonymousOwner(pool);
    const run = await createRun(pool, fixture.paths.domain, owner);
    const channel = await rabbitMq.getConfirmChannel();
    const successfulRuntime = new AnalysisRunWorkerRuntime(
      channel,
      new AnalysisRunWorker(new AnalysisRunExpansionService(pool)),
      new FailureRecordRepository(pool),
      { mainExchange: "geo.v6.test.main", prefetch: 1 },
      { info() {}, warn() {}, error() {} }
    );
    await successfulRuntime.start();
    await sendEnvelope(channel, envelope(run));
    await pollUntil(async () => (await runState(pool, run.runId)).status === "processing");
    await successfulRuntime.stop();

    const failedMessage = {
      ...envelope(run),
      messageId: "expansion-exhausted-retry"
    };
    const failingRuntime = new AnalysisRunWorkerRuntime(
      channel,
      {
        async process() {
          throw new Error("simulated technical failure");
        }
      },
      new FailureRecordRepository(pool),
      { mainExchange: "geo.v6.test.main", prefetch: 1 },
      { info() {}, warn() {}, error() {} }
    );
    await failingRuntime.start();
    await sendEnvelope(channel, failedMessage);
    const deadLetter = await pollMessage(
      channel,
      deadLetterQueueName("analysis_run_queue")
    );
    await failingRuntime.stop();
    assert.equal(deadLetter.properties.messageId, failedMessage.messageId);
    channel.ack(deadLetter);
    const failures = await pool.query<{ attempt_number: number }>(
      `SELECT attempt_number FROM failure_records
       WHERE queue_name = 'analysis_run_queue' AND message_id = $1
       ORDER BY attempt_number`,
      [failedMessage.messageId]
    );
    assert.deepEqual(failures.rows.map((row) => row.attempt_number), [1, 2, 3]);
  });
  }
);

type Owner = {
  actorType: "anonymous" | "user";
  anonymousSessionId: string | null;
  userId: string | null;
  workspaceId: string | null;
};

async function seedHierarchy(pool: pg.Pool, width: number) {
  const domain = await pool.query<{ domain_id: string }>(
    "INSERT INTO domains (normalized_domain) VALUES ('expansion.example') RETURNING domain_id"
  );
  const domainId = domain.rows[0]!.domain_id;
  const categories: string[] = [];
  const brands: string[] = [];
  const products: string[] = [];
  const contexts: string[] = [];
  const sort = [2, 1, null, 3, 4, 5];
  let firstDomainCategory = "";
  let firstCategoryBrand = "";
  let firstBrandProduct = "";

  for (let index = 0; index < width; index += 1) {
    const category = await master(pool, "categories", "category", `c${index}`);
    categories.push(category);
    const relationship = await pool.query<{ id: string }>(
      `INSERT INTO domain_categories (domain_id, category_id, sort_order)
       VALUES ($1, $2, $3) RETURNING domain_category_id AS id`,
      [domainId, category, sort[index]]
    );
    if (index === 0) firstDomainCategory = relationship.rows[0]!.id;
  }
  for (let index = 0; index < width; index += 1) {
    const brand = await master(pool, "brands", "brand", `b${index}`);
    brands.push(brand);
    const relationship = await pool.query<{ id: string }>(
      `INSERT INTO category_brands (domain_category_id, brand_id, sort_order)
       VALUES ($1, $2, $3) RETURNING category_brand_id AS id`,
      [firstDomainCategory, brand, sort[index]]
    );
    if (index === 0) firstCategoryBrand = relationship.rows[0]!.id;
  }
  for (let index = 0; index < width; index += 1) {
    const product = await master(pool, "products", "product", `p${index}`);
    products.push(product);
    const relationship = await pool.query<{ id: string }>(
      `INSERT INTO brand_products (category_brand_id, product_id, sort_order)
       VALUES ($1, $2, $3) RETURNING brand_product_id AS id`,
      [firstCategoryBrand, product, sort[index]]
    );
    if (index === 0) firstBrandProduct = relationship.rows[0]!.id;
  }
  for (let index = 0; index < width; index += 1) {
    const context = await master(pool, "use_contexts", "use_context", `u${index}`);
    contexts.push(context);
    await pool.query(
      `INSERT INTO product_use_contexts (brand_product_id, use_context_id, sort_order)
       VALUES ($1, $2, $3)`,
      [firstBrandProduct, context, sort[index]]
    );
  }

  return {
    domainId,
    categories,
    paths: {
      domain: await entityPath(pool, { domainId, pathType: "domain" }),
      category: await entityPath(pool, {
        domainId,
        categoryId: categories[0]!,
        pathType: "category"
      }),
      brand: await entityPath(pool, {
        domainId,
        categoryId: categories[0]!,
        brandId: brands[0]!,
        pathType: "brand"
      }),
      product: await entityPath(pool, {
        domainId,
        categoryId: categories[0]!,
        brandId: brands[0]!,
        productId: products[0]!,
        pathType: "product"
      }),
      useContext: await entityPath(pool, {
        domainId,
        categoryId: categories[0]!,
        brandId: brands[0]!,
        productId: products[0]!,
        useContextId: contexts[0]!,
        pathType: "use_context"
      })
    }
  };
}

async function master(
  pool: pg.Pool,
  table: "categories" | "brands" | "products" | "use_contexts",
  prefix: "category" | "brand" | "product" | "use_context",
  value: string
) {
  const id = `${prefix}_id`;
  const name = `${prefix}_name`;
  const result = await pool.query<Record<string, string>>(
    `INSERT INTO ${table} (${name}, normalized_name)
     VALUES ($1, $2) RETURNING ${id}`,
    [`Expansion ${value}`, `expansion-${prefix}-${value}`]
  );
  return result.rows[0]![id]!;
}

async function entityPath(
  pool: pg.Pool,
  input: {
    domainId: string;
    categoryId?: string;
    brandId?: string;
    productId?: string;
    useContextId?: string;
    pathType: EntityPathType;
  }
) {
  const result = await pool.query<{ entity_path_id: string }>(
    `INSERT INTO entity_paths
       (domain_id, category_id, brand_id, product_id, use_context_id, path_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ON CONSTRAINT entity_paths_hierarchy_unique DO UPDATE
       SET updated_at = entity_paths.updated_at
     RETURNING entity_path_id`,
    [
      input.domainId,
      input.categoryId ?? null,
      input.brandId ?? null,
      input.productId ?? null,
      input.useContextId ?? null,
      input.pathType
    ]
  );
  return result.rows[0]!.entity_path_id;
}

async function anonymousOwner(pool: pg.Pool): Promise<Owner> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO anonymous_sessions (token_hash, expires_at)
     VALUES ($1, now() + interval '1 day')
     RETURNING anonymous_session_id AS id`,
    [`anon-${crypto.randomUUID()}`]
  );
  return {
    actorType: "anonymous",
    anonymousSessionId: result.rows[0]!.id,
    userId: null,
    workspaceId: null
  };
}

async function userOwner(pool: pg.Pool): Promise<Owner> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email) VALUES ($1) RETURNING user_id AS id`,
    [`${crypto.randomUUID()}@expansion.example`]
  );
  const userId = user.rows[0]!.id;
  const workspace = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (workspace_name, created_by_user_id)
     VALUES ('Expansion', $1) RETURNING workspace_id AS id`,
    [userId]
  );
  const workspaceId = workspace.rows[0]!.id;
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [workspaceId, userId]
  );
  return {
    actorType: "user",
    anonymousSessionId: null,
    userId,
    workspaceId
  };
}

async function claimedOwner(pool: pg.Pool): Promise<Owner> {
  const owner = await userOwner(pool);
  const anonymous = await anonymousOwner(pool);
  await pool.query(
    `UPDATE anonymous_sessions
     SET claimed_by_user_id = $2, claimed_workspace_id = $3, claimed_at = now()
     WHERE anonymous_session_id = $1`,
    [anonymous.anonymousSessionId, owner.userId, owner.workspaceId]
  );
  return { ...owner, anonymousSessionId: anonymous.anonymousSessionId };
}

async function createRun(pool: pg.Pool, pathId: string, owner: Owner) {
  const result = await pool.query<{ analysis_run_id: string }>(
    `INSERT INTO analysis_runs
       (idempotency_key, anonymous_session_id, user_id, workspace_id,
        starting_entity_path_id, request_payload)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)
     RETURNING analysis_run_id`,
    [
      crypto.randomUUID(),
      owner.anonymousSessionId,
      owner.userId,
      owner.workspaceId,
      pathId
    ]
  );
  return { runId: result.rows[0]!.analysis_run_id, pathId };
}

function payload(
  run: { runId: string; pathId: string }
): AnalysisRunCreatedPayload {
  return {
    analysisRunId: run.runId
  };
}

function envelope(run: { runId: string; pathId: string }) {
  return {
    messageId: `analysis_run.created:${run.runId}`,
    eventType: "analysis_run.created",
    aggregateType: "analysis_run",
    aggregateId: run.runId,
    occurredAt: new Date().toISOString(),
    attempt: 1,
    payload: payload(run)
  };
}

async function runItems(pool: pg.Pool, runId: string) {
  const result = await pool.query<{
    analysis_run_item_id: string;
    entity_path_id: string;
    item_ordinal: number;
    status: string;
    path_type: string;
    category_id: string | null;
  }>(
    `SELECT item.*, path.path_type, path.category_id
     FROM analysis_run_items AS item
     JOIN entity_paths AS path ON path.entity_path_id = item.entity_path_id
     WHERE item.analysis_run_id = $1 ORDER BY item.item_ordinal`,
    [runId]
  );
  return result.rows;
}

async function runState(pool: pg.Pool, runId: string) {
  const result = await pool.query<{
    status: string;
    error_code: string | null;
    started_at: Date | null;
    completed_at: Date | null;
  }>("SELECT * FROM analysis_runs WHERE analysis_run_id = $1", [runId]);
  return result.rows[0]!;
}

async function itemOutboxCount(pool: pg.Pool, runId: string) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)
     FROM outbox_events AS event
     JOIN analysis_run_items AS item
       ON item.analysis_run_item_id = event.aggregate_id::bigint
     WHERE item.analysis_run_id = $1
       AND event.event_type = 'analysis_run_item.created'`,
    [runId]
  );
  return Number(result.rows[0]!.count);
}

async function assertIdOnlyEvents(pool: pg.Pool, runId: string) {
  const result = await pool.query<{ payload: Record<string, unknown>; headers: unknown }>(
    `SELECT event.payload, event.headers
     FROM outbox_events AS event
     JOIN analysis_run_items AS item
       ON item.analysis_run_item_id = event.aggregate_id::bigint
     WHERE item.analysis_run_id = $1`,
    [runId]
  );
  const expected = ["analysisRunItemId"];
  for (const event of result.rows) {
    assert.deepEqual(Object.keys(event.payload).sort(), expected);
    assert.deepEqual(event.headers, { queueName: "analysis_run_item_queue" });
    assert.ok(
      Object.values(event.payload).every(
        (value) => value === null || typeof value === "string"
      )
    );
  }
}

async function countFailureRecords(pool: pg.Pool) {
  return Number(
    (
      await pool.query<{ count: string }>(
        "SELECT count(*) FROM failure_records"
      )
    ).rows[0]!.count
  );
}

async function masterCounts(pool: pg.Pool) {
  const counts: Record<string, string> = {};
  for (const table of [
    "categories",
    "brands",
    "products",
    "use_contexts",
    "domain_categories",
    "category_brands",
    "brand_products",
    "product_use_contexts"
  ]) {
    const result = await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
    counts[table] = result.rows[0]!.count;
  }
  return counts;
}

async function sendEnvelope(
  channel: Awaited<ReturnType<RabbitMqConnection["getConfirmChannel"]>>,
  value: object
) {
  await new Promise<void>((resolve, reject) => {
    channel.publish(
      "geo.v6.test.main",
      "analysis_run_queue",
      Buffer.from(JSON.stringify(value)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: (value as { messageId: string }).messageId
      },
      (error) => (error ? reject(error) : resolve())
    );
  });
}

async function pollUntil(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for analysis expansion worker outcome");
}

async function pollMessage(
  channel: Awaited<ReturnType<RabbitMqConnection["getConfirmChannel"]>>,
  queue: string
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const message = await channel.get(queue, { noAck: false });
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${queue}`);
}
