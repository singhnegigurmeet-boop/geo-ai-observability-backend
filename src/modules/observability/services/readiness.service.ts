import type { ConfirmChannel } from "amqplib";
import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import {
  getDefaultMigrationsDirectory,
  loadMigrationFiles
} from "../../../common/database/migration-runner.js";
import type { RabbitMqConnection } from "../../../common/messaging/rabbitmq.connection.js";
import {
  QUEUE_NAMES,
  deadLetterQueueName
} from "../../../common/messaging/queue-names.js";

type ReadinessCheck = { status: "ok" | "failed" };

export type ReadinessResult = {
  status: "ready" | "not_ready";
  checks: {
    database: ReadinessCheck;
    migrations: ReadinessCheck;
    rabbitmq: ReadinessCheck;
    queues: ReadinessCheck;
  };
};

type ReadinessRabbitMq = Pick<RabbitMqConnection, "getConfirmChannel">;

export class ReadinessService {
  constructor(
    private readonly database: DatabaseExecutor,
    private readonly rabbitMq: ReadinessRabbitMq
  ) {}

  async check(): Promise<ReadinessResult> {
    const checks: ReadinessResult["checks"] = {
      database: { status: "failed" },
      migrations: { status: "failed" },
      rabbitmq: { status: "failed" },
      queues: { status: "failed" }
    };

    try {
      await this.database.query("SELECT 1");
      checks.database.status = "ok";
      const files = await loadMigrationFiles(getDefaultMigrationsDirectory());
      const ledger = await this.database.query<{
        version: number;
        filename: string;
        checksum: string;
      }>(
        `
          SELECT version, filename, checksum
          FROM geo_meta.schema_migrations
          ORDER BY version
        `
      );
      if (
        ledger.rows.length === files.length &&
        files.every((file, index) => {
          const applied = ledger.rows[index];
          return (
            applied?.version === file.version &&
            applied.filename === file.filename &&
            applied.checksum === file.checksum
          );
        })
      ) {
        checks.migrations.status = "ok";
      }
    } catch {
      // Readiness responses deliberately expose no database details.
    }

    let channel: ConfirmChannel | null = null;
    try {
      channel = await this.rabbitMq.getConfirmChannel();
      checks.rabbitmq.status = "ok";
      await assertCriticalQueues(channel);
      checks.queues.status = "ok";
    } catch {
      // Readiness responses deliberately expose no broker details.
    }

    const ready = Object.values(checks).every(
      (check) => check.status === "ok"
    );
    return {
      status: ready ? "ready" : "not_ready",
      checks
    };
  }
}

async function assertCriticalQueues(channel: Pick<ConfirmChannel, "checkQueue">) {
  for (const queueName of QUEUE_NAMES) {
    await channel.checkQueue(queueName);
    await channel.checkQueue(deadLetterQueueName(queueName));
  }
}
