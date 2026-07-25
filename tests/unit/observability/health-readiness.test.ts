import assert from "node:assert/strict";
import type { Server } from "node:http";
import { describe, it } from "node:test";
import { Router } from "express";
import { createApp } from "../../../src/app.js";
import {
  getDefaultMigrationsDirectory,
  loadMigrationFiles
} from "../../../src/common/database/migration-runner.js";
import { QUEUE_NAMES, deadLetterQueueName } from "../../../src/common/messaging/queue-names.js";
import { ReadinessService } from "../../../src/modules/observability/services/readiness.service.js";

describe("readiness service", () => {
  it("keeps liveness independent from readiness dependencies", async () => {
    let readinessCalls = 0;
    const server = await new Promise<Server>((resolve) => {
      const listening = createApp({
        analysisRouter: Router(),
        readinessService: {
          async check() {
            readinessCalls += 1;
            throw new Error("dependency should not be called by liveness");
          }
        }
      }).listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP test server");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
      assert.equal(readinessCalls, 0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it("requires the exact migration ledger and every queue/DLQ", async () => {
    const files = await loadMigrationFiles(getDefaultMigrationsDirectory());
    const checked: string[] = [];
    const service = new ReadinessService(
      {
        async query(text: string) {
          return {
            rows: text.includes("schema_migrations")
              ? files.map(({ version, filename, checksum }) => ({
                  version,
                  filename,
                  checksum
                }))
              : [{ "?column?": 1 }]
          } as never;
        }
      },
      {
        async getConfirmChannel() {
          return {
            async checkQueue(name: string) {
              checked.push(name);
              return { queue: name, messageCount: 0, consumerCount: 0 };
            }
          } as never;
        }
      }
    );
    assert.equal((await service.check()).status, "ready");
    assert.deepEqual(
      checked,
      QUEUE_NAMES.flatMap((name) => [name, deadLetterQueueName(name)])
    );
  });

  it("fails closed without leaking dependency error details", async () => {
    const service = new ReadinessService(
      {
        async query() {
          throw new Error("postgres://secret-password@private-host");
        }
      },
      {
        async getConfirmChannel() {
          throw new Error("amqp://secret-password@private-host");
        }
      }
    );
    const result = await service.check();
    assert.equal(result.status, "not_ready");
    assert.deepEqual(result.checks, {
      database: { status: "failed" },
      migrations: { status: "failed" },
      rabbitmq: { status: "failed" },
      queues: { status: "failed" }
    });
    assert.doesNotMatch(JSON.stringify(result), /secret-password|private-host/);
  });
});
