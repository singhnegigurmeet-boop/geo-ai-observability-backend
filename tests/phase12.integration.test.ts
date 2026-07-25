import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { AnalysisRunExpansionService } from "../src/analysis/analysis-run-expansion.service.js";
import {
  getDefaultMigrationsDirectory,
  runMigrations
} from "../src/db/migration-runner.js";
import { RabbitMqConnection } from "../src/messaging/rabbitmq.connection.js";
import { declareRabbitMqTopology } from "../src/messaging/rabbitmq.topology.js";
import { NotificationService } from "../src/notifications/notification.service.js";
import { ReadinessService } from "../src/observability/readiness.service.js";
import { SchedulerService } from "../src/scheduler/scheduler.service.js";

const enabled = process.env.RUN_PHASE12_INTEGRATION_TESTS === "true";

describe("Phase 12 scheduler, notifications, and readiness", {
  skip: !enabled,
  concurrency: 1
}, () => {
  let pool: pg.Pool;
  let rabbitMq: RabbitMqConnection;

  before(async () => {
    pool = new pg.Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ??
        "postgres://postgres:postgres@127.0.0.1:5433/geo_observability_test"
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
    await runMigrations({
      pool,
      migrationsDirectory: getDefaultMigrationsDirectory()
    });
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
  });

  beforeEach(async () => {
    const tables = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    await pool.query(
      `TRUNCATE ${tables.rows
        .map((row) => `"${row.tablename}"`)
        .join(", ")} RESTART IDENTITY CASCADE`
    );
  });

  after(async () => {
    await rabbitMq?.close();
    await pool?.end();
  });

  it("claims one due tick concurrently, advances it, and enters the normal pipeline", async () => {
    const fixture = await seedOwnedHierarchy(pool);
    const dueAt = new Date("2026-07-25T00:00:00.000Z");
    const schedule = await pool.query<{ scheduler_job_id: string }>(
      `
        INSERT INTO scheduler_jobs (
          idempotency_key, workspace_id, created_by_user_id,
          starting_entity_path_id, job_name, schedule_expression,
          request_payload, next_run_at
        )
        VALUES ($1, $2, $3, $4, 'daily visibility', 'interval:3600',
                '{"requestedProvider":"mock","requestedModel":"mock-standard"}',
                $5)
        RETURNING scheduler_job_id
      `,
      [
        "phase12-schedule",
        fixture.workspaceId,
        fixture.userId,
        fixture.pathId,
        dueAt
      ]
    );
    const scheduler = new SchedulerService(pool);
    const outcomes = await Promise.all([
      scheduler.tick(dueAt),
      scheduler.tick(dueAt)
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.outcome === "enqueued").length,
      1
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.outcome === "idle").length,
      1
    );

    const state = await pool.query<{
      analysis_run_id: string;
      source: string;
      next_run_at: Date;
      run_count: string;
      outbox_count: string;
    }>(
      `
        SELECT schedule.last_analysis_run_id AS analysis_run_id,
               run.source, schedule.next_run_at,
               (SELECT count(*)::text FROM analysis_runs) AS run_count,
               (SELECT count(*)::text FROM outbox_events
                WHERE event_type = 'analysis_run.created') AS outbox_count
        FROM scheduler_jobs AS schedule
        JOIN analysis_runs AS run
          ON run.analysis_run_id = schedule.last_analysis_run_id
        WHERE schedule.scheduler_job_id = $1
      `,
      [schedule.rows[0]!.scheduler_job_id]
    );
    assert.equal(state.rows[0]?.source, "scheduled");
    assert.equal(state.rows[0]?.run_count, "1");
    assert.equal(state.rows[0]?.outbox_count, "1");
    assert.equal(
      state.rows[0]?.next_run_at.toISOString(),
      "2026-07-25T01:00:00.000Z"
    );

    const expanded = await new AnalysisRunExpansionService(pool).expand({
      analysisRunId: state.rows[0]!.analysis_run_id,
      startingEntityPathId: fixture.pathId,
      actorType: "user",
      userId: fixture.userId,
      workspaceId: fixture.workspaceId,
      anonymousSessionId: null
    });
    assert.deepEqual(expanded, { outcome: "expanded", itemCount: 1 });
  });

  it("pauses an invalid schedule and records one admin notification transactionally", async () => {
    const fixture = await seedOwnedHierarchy(pool);
    const dueAt = new Date("2026-07-25T00:00:00.000Z");
    await pool.query(
      `
        INSERT INTO scheduler_jobs (
          idempotency_key, workspace_id, created_by_user_id,
          starting_entity_path_id, job_name, schedule_expression,
          next_run_at
        )
        VALUES ('invalid-schedule', $1, $2, $3, 'invalid',
                'cron:* * * * *', $4)
      `,
      [fixture.workspaceId, fixture.userId, fixture.pathId, dueAt]
    );
    const result = await new SchedulerService(pool).tick(dueAt);
    assert.equal(result.outcome, "failed");
    const state = await pool.query<{
      status: string;
      runs: string;
      failures: string;
      notifications: string;
      events: string;
    }>(
      `
        SELECT status,
          (SELECT count(*)::text FROM analysis_runs) AS runs,
          (SELECT count(*)::text FROM failure_records) AS failures,
          (SELECT count(*)::text FROM notifications
           WHERE is_admin_notification) AS notifications,
          (SELECT count(*)::text FROM outbox_events
           WHERE event_type = 'notification.created') AS events
        FROM scheduler_jobs
      `
    );
    assert.deepEqual(state.rows[0], {
      status: "paused",
      runs: "0",
      failures: "1",
      notifications: "1",
      events: "1"
    });
  });

  it("revalidates scheduler authorization and hierarchy before creating a run", async () => {
    for (const invalidation of ["user", "hierarchy"] as const) {
      await truncatePublicTables(pool);
      const fixture = await seedOwnedHierarchy(pool);
      const dueAt = new Date("2026-07-25T00:00:00.000Z");
      await pool.query(
        `INSERT INTO scheduler_jobs (
           idempotency_key, workspace_id, created_by_user_id,
           starting_entity_path_id, job_name, schedule_expression,
           request_payload, next_run_at
         )
         VALUES ($1, $2, $3, $4, 'revalidation', 'interval:3600',
                 '{"requestedProvider":"mock","requestedModel":"mock-standard"}',
                 $5)`,
        [
          `phase12-revalidate-${invalidation}`,
          fixture.workspaceId,
          fixture.userId,
          fixture.pathId,
          dueAt
        ]
      );
      if (invalidation === "user") {
        await pool.query(
          "UPDATE users SET status = 'disabled' WHERE user_id = $1",
          [fixture.userId]
        );
      } else {
        await pool.query(
          `UPDATE domains SET is_active = false
           WHERE domain_id = (
             SELECT domain_id FROM entity_paths WHERE entity_path_id = $1
           )`,
          [fixture.pathId]
        );
      }

      assert.equal((await new SchedulerService(pool).tick(dueAt)).outcome, "failed");
      const state = await pool.query<{
        status: string;
        runs: string;
        events: string;
        error_code: string;
      }>(
        `SELECT schedule.status,
                (SELECT count(*)::text FROM analysis_runs) AS runs,
                (SELECT count(*)::text FROM outbox_events
                 WHERE event_type = 'analysis_run.created') AS events,
                failure.error_code
         FROM scheduler_jobs AS schedule
         JOIN failure_records AS failure
           ON failure.aggregate_type = 'scheduler_job'
          AND failure.aggregate_id = schedule.scheduler_job_id::text`
      );
      assert.equal(state.rows[0]?.status, "paused");
      assert.equal(state.rows[0]?.runs, "0");
      assert.equal(state.rows[0]?.events, "0");
      assert.equal(
        state.rows[0]?.error_code,
        invalidation === "user"
          ? "SCHEDULER_AUTHORIZATION_NO_LONGER_VALID"
          : "HIERARCHY_NO_LONGER_VALID"
      );
    }
  });

  it("creates owner-scoped report/budget notifications once and delivers internally once", async () => {
    const fixture = await seedOwnedHierarchy(pool);
    const run = await seedRun(pool, fixture, "processing");
    await pool.query(
      `
        INSERT INTO reports (
          idempotency_key, analysis_run_id, report_version,
          status, report_data
        )
        VALUES ('report-notify', $1, 'basic-v1', 'completed', '{}')
      `,
      [run]
    );
    await pool.query(
      "UPDATE analysis_runs SET status = 'paused_budget' WHERE analysis_run_id = $1",
      [run]
    );
    await pool.query(
      "UPDATE analysis_runs SET status = 'paused_budget' WHERE analysis_run_id = $1",
      [run]
    );
    const records = await pool.query<{
      notification_id: string;
      analysis_run_id: string;
      user_id: string;
      workspace_id: string;
      type: string;
    }>(
      `
        SELECT notification_id, analysis_run_id, user_id, workspace_id,
               payload->>'type' AS type
        FROM notifications
        ORDER BY notification_id
      `
    );
    assert.deepEqual(
      records.rows.map((row) => row.type),
      ["report_ready", "budget_paused"]
    );
    assert.ok(
      records.rows.every(
        (row) =>
          row.analysis_run_id === run &&
          row.user_id === fixture.userId &&
          row.workspace_id === fixture.workspaceId
      )
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::text AS count FROM outbox_events WHERE event_type = 'notification.created'"
        )
      ).rows[0]?.count,
      "2"
    );

    const notification = records.rows[0]!;
    const service = new NotificationService(pool);
    const payload = {
      notificationId: notification.notification_id,
      analysisRunId: run,
      failureRecordId: null,
      isAdmin: false
    };
    assert.equal((await service.deliverInternal(payload)).outcome, "sent");
    assert.equal((await service.deliverInternal(payload)).outcome, "noop");
    const delivery = await pool.query<{ status: string; attempt_count: number }>(
      "SELECT status, attempt_count FROM notifications WHERE notification_id = $1",
      [notification.notification_id]
    );
    assert.deepEqual(delivery.rows[0], { status: "sent", attempt_count: 1 });
  });

  it("creates one admin notification for idempotent terminal failure and reports ready", async () => {
    await pool.query(
      `
        INSERT INTO failure_records (
          queue_name, message_id, attempt_number, error_code,
          error_message, error_details
        )
        VALUES ('openai_queue', 'terminal-1', 3, 'PROVIDER_TIMEOUT',
                'safe failure', '{"permanent":false}')
        ON CONFLICT (queue_name, message_id, attempt_number) DO NOTHING
      `
    );
    await pool.query(
      `
        INSERT INTO failure_records (
          queue_name, message_id, attempt_number, error_code,
          error_message, error_details
        )
        VALUES ('openai_queue', 'terminal-1', 3, 'PROVIDER_TIMEOUT',
                'safe failure', '{"permanent":false}')
        ON CONFLICT (queue_name, message_id, attempt_number) DO NOTHING
      `
    );
    const admin = await pool.query<{
      count: string;
      user_id: string | null;
      workspace_id: string | null;
    }>(
      `
        SELECT count(*)::text AS count, min(user_id)::text AS user_id,
               min(workspace_id)::text AS workspace_id
        FROM notifications
        WHERE is_admin_notification
      `
    );
    assert.deepEqual(admin.rows[0], {
      count: "1",
      user_id: null,
      workspace_id: null
    });

    const readiness = await new ReadinessService(pool, rabbitMq).check();
    assert.equal(readiness.status, "ready");
  });
});

async function seedOwnedHierarchy(pool: pg.Pool) {
  const user = await pool.query<{ user_id: string }>(
    "INSERT INTO users (email) VALUES ('phase12@example.com') RETURNING user_id"
  );
  const workspace = await pool.query<{ workspace_id: string }>(
    `
      INSERT INTO workspaces (workspace_name, created_by_user_id)
      VALUES ('Phase 12', $1)
      RETURNING workspace_id
    `,
    [user.rows[0]!.user_id]
  );
  await pool.query(
    `
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES ($1, $2, 'owner')
    `,
    [workspace.rows[0]!.workspace_id, user.rows[0]!.user_id]
  );
  const domain = await pool.query<{ domain_id: string }>(
    "INSERT INTO domains (normalized_domain) VALUES ('phase12.example') RETURNING domain_id"
  );
  const category = await pool.query<{ category_id: string }>(
    `
      INSERT INTO categories (category_name, normalized_name)
      VALUES ('Phase 12 category', 'phase 12 category')
      RETURNING category_id
    `
  );
  await pool.query(
    "INSERT INTO domain_categories (domain_id, category_id) VALUES ($1, $2)",
    [domain.rows[0]!.domain_id, category.rows[0]!.category_id]
  );
  const path = await pool.query<{ entity_path_id: string }>(
    `
      INSERT INTO entity_paths (domain_id, path_type)
      VALUES ($1, 'domain')
      RETURNING entity_path_id
    `,
    [domain.rows[0]!.domain_id]
  );
  return {
    userId: user.rows[0]!.user_id,
    workspaceId: workspace.rows[0]!.workspace_id,
    pathId: path.rows[0]!.entity_path_id
  };
}

async function seedRun(
  pool: pg.Pool,
  fixture: Awaited<ReturnType<typeof seedOwnedHierarchy>>,
  status: "queued" | "processing"
) {
  const result = await pool.query<{ analysis_run_id: string }>(
    `
      INSERT INTO analysis_runs (
        idempotency_key, user_id, workspace_id,
        starting_entity_path_id, source, status, request_payload,
        requested_provider, requested_model
      )
      VALUES ('phase12-run', $1, $2, $3, 'manual', $4, '{}',
              'mock', 'mock-standard')
      RETURNING analysis_run_id
    `,
    [fixture.userId, fixture.workspaceId, fixture.pathId, status]
  );
  return result.rows[0]!.analysis_run_id;
}

async function truncatePublicTables(pool: pg.Pool) {
  const tables = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  await pool.query(
    `TRUNCATE ${tables.rows
      .map((row) => `"${row.tablename}"`)
      .join(", ")} RESTART IDENTITY CASCADE`
  );
}
