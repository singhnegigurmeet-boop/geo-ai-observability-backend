import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SchedulerRepository } from "../../../src/modules/scheduler/repositories/scheduler.repository.js";
import { parseInterval } from "../../../src/modules/scheduler/services/scheduler.service.js";

describe("scheduler interval policy", () => {
  it("accepts bounded interval schedules", () => {
    assert.equal(parseInterval("interval:60"), 60);
    assert.equal(parseInterval("interval:31536000"), 31_536_000);
  });

  it("rejects unsupported, short, and excessive schedules", () => {
    for (const value of [
      "cron:* * * * *",
      "interval:59",
      "interval:31536001",
      "interval:1.5",
      "interval:-60"
    ]) {
      assert.throws(() => parseInterval(value));
    }
  });
});

describe("scheduler due-row claiming", () => {
  it("uses PostgreSQL row locking with skip locked", async () => {
    const queries: string[] = [];
    const repository = new SchedulerRepository({
      async query(text: string) {
        queries.push(text);
        return { rows: [], rowCount: 0 } as never;
      }
    });
    assert.equal(await repository.claimNextDue(new Date()), null);
    assert.match(queries[0] ?? "", /FOR UPDATE OF schedule SKIP LOCKED/);
  });
});
