import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OutboxDispatcher,
  calculateRetryDelay,
  type QueuePublisher
} from "../src/outbox/outbox.dispatcher.js";
import type { OutboxRepositoryContract } from "../src/outbox/outbox.repository.js";
import type {
  ClaimedOutboxEvent,
  OutboxFailure
} from "../src/outbox/outbox.types.js";

describe("outbox dispatcher", () => {
  it("marks confirmed events published and does not publish them on rerun", async () => {
    const event = createEvent();
    const published: string[] = [];
    const repository = new FakeRepository([event]);
    const publisher: QueuePublisher = {
      async publish(_queueName, message) {
        published.push(message.messageId);
      }
    };
    const dispatcher = createDispatcher(repository, publisher);

    assert.equal(await dispatcher.dispatchBatch(), 1);
    assert.equal(await dispatcher.dispatchBatch(), 0);
    assert.deepEqual(published, ["event-1"]);
    assert.deepEqual(repository.published, [
      {
        outboxEventId: "1",
        dispatcherId: "dispatcher-test"
      }
    ]);
    assert.deepEqual(repository.failures, []);
  });

  it("records publish failures as retryable with exponential backoff", async () => {
    const event = createEvent({ attempt_count: 3 });
    const repository = new FakeRepository([event]);
    const publisher: QueuePublisher = {
      async publish() {
        const error = new Error("broker unavailable") as Error & { code: string };
        error.code = "BROKER_DOWN";
        throw error;
      }
    };
    const dispatcher = createDispatcher(repository, publisher);

    assert.equal(await dispatcher.dispatchBatch(), 1);
    assert.equal(repository.published.length, 0);
    assert.equal(repository.failures.length, 1);
    assert.equal(repository.failures[0]?.errorCode, "BROKER_DOWN");
    assert.equal(repository.failures[0]?.errorMessage, "broker unavailable");
    assert.equal(
      repository.failures[0]?.availableAt.toISOString(),
      "2026-01-01T00:00:04.000Z"
    );
  });

  it("rejects an invalid queue route without invoking the publisher", async () => {
    const event = createEvent({ headers: {} });
    const repository = new FakeRepository([event]);
    let publishCalls = 0;
    const publisher: QueuePublisher = {
      async publish() {
        publishCalls += 1;
      }
    };

    await createDispatcher(repository, publisher).dispatchBatch();

    assert.equal(publishCalls, 0);
    assert.equal(repository.failures.length, 1);
    assert.equal(repository.failures[0]?.errorCode, "InvalidOutboxRouteError");
  });

  it("caps retry delays", () => {
    assert.equal(calculateRetryDelay(1, 1_000, 60_000), 1_000);
    assert.equal(calculateRetryDelay(4, 1_000, 60_000), 8_000);
    assert.equal(calculateRetryDelay(20, 1_000, 60_000), 60_000);
  });
});

class FakeRepository implements OutboxRepositoryContract {
  published: Array<{ outboxEventId: string; dispatcherId: string }> = [];
  failures: OutboxFailure[] = [];
  private returned = false;

  constructor(private readonly events: ClaimedOutboxEvent[]) {}

  async claimBatch() {
    if (this.returned) {
      return [];
    }
    this.returned = true;
    return this.events;
  }

  async markPublished(
    outboxEventId: string,
    dispatcherId: string,
    _publishedAt: Date
  ) {
    this.published.push({ outboxEventId, dispatcherId });
    return true;
  }

  async markFailed(failure: OutboxFailure) {
    this.failures.push(failure);
    return true;
  }
}

function createDispatcher(
  repository: OutboxRepositoryContract,
  publisher: QueuePublisher
) {
  return new OutboxDispatcher(
    repository,
    publisher,
    {
      dispatcherId: "dispatcher-test",
      batchSize: 10,
      pollIntervalMs: 100,
      lockTimeoutMs: 60_000,
      retryBaseMs: 1_000,
      retryMaxMs: 60_000
    },
    {
      info() {},
      warn() {},
      error() {}
    },
    () => new Date("2026-01-01T00:00:00.000Z")
  );
}

function createEvent(
  overrides: Partial<ClaimedOutboxEvent> = {}
): ClaimedOutboxEvent {
  return {
    outbox_event_id: "1",
    event_key: "event-1",
    aggregate_type: "analysis_run",
    aggregate_id: "42",
    event_type: "analysis_run.created",
    event_version: 1,
    payload: { analysisRunId: "42" },
    headers: { queueName: "analysis_run_queue" },
    status: "publishing",
    attempt_count: 1,
    available_at: new Date("2026-01-01T00:00:00.000Z"),
    locked_at: new Date("2026-01-01T00:00:00.000Z"),
    locked_by: "dispatcher-test",
    published_at: null,
    last_error_code: null,
    last_error_message: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides
  };
}
