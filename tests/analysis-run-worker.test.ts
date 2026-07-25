import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsumeMessage } from "amqplib";
import type { AnalysisRunExpansionResult } from "../src/analysis/analysis-run-expansion.service.js";
import { AnalysisRunWorker } from "../src/analysis/analysis-run-worker.js";
import type { RecordWorkerFailure } from "../src/reliability/failure-record.repository.js";
import { AnalysisRunWorkerRuntime } from "../src/runtime/analysis-run-worker.runtime.js";

describe("analysis run worker handler", () => {
  it("passes a validated payload to the expansion service", async () => {
    const received: unknown[] = [];
    const worker = new AnalysisRunWorker({
      async expand(payload) {
        received.push(payload);
        return { outcome: "expanded", itemCount: 1 };
      }
    });
    const result = await worker.process(validEnvelope());
    assert.deepEqual(result, { outcome: "expanded", itemCount: 1 });
    assert.deepEqual(received, [validEnvelope().payload]);
  });
});

describe("analysis run worker RabbitMQ reliability", () => {
  it("consumes analysis_run_queue with configured prefetch", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    assert.equal(harness.channel.consumedQueue, "analysis_run_queue");
    assert.equal(harness.channel.prefetchCount, 7);
    await harness.runtime.stop();
    assert.equal(harness.channel.cancelledTag, "consumer-1");
  });

  it("acknowledges successful and empty business outcomes", async () => {
    for (const result of [
      { outcome: "expanded" as const, itemCount: 2 },
      { outcome: "empty" as const, itemCount: 0 }
    ] satisfies AnalysisRunExpansionResult[]) {
      const harness = createHarness({ result });
      const delivery = message();
      await harness.runtime.handleDelivery(delivery);
      assert.deepEqual(harness.channel.acked, [delivery]);
      assert.deepEqual(harness.channel.nacked, []);
    }
  });

  it("attempts 1 and 2 record, confirmed-republish, then acknowledge", async () => {
    for (const attempt of [1, 2]) {
      const harness = createHarness({ error: new Error("database unavailable") });
      const delivery = message(attempt);
      await harness.runtime.handleDelivery(delivery);
      assert.equal(harness.failures.length, 1);
      assert.equal(harness.failures[0]?.attemptNumber, attempt);
      assert.equal(harness.channel.published.length, 1);
      assert.equal(
        harness.channel.published[0]?.options.headers?.["x-worker-attempt"],
        attempt + 1
      );
      assert.deepEqual(harness.channel.acked, [delivery]);
      assert.deepEqual(harness.channel.nacked, []);
    }
  });

  it("attempt 3 records and rejects without requeue for DLQ routing", async () => {
    const harness = createHarness({ error: new Error("still unavailable") });
    const delivery = message(3);
    await harness.runtime.handleDelivery(delivery);
    assert.equal(harness.channel.published.length, 0);
    assert.deepEqual(harness.channel.nacked, [
      { message: delivery, allUpTo: false, requeue: false }
    ]);
  });

  it("malformed messages are recorded and rejected without requeue", async () => {
    const harness = createHarness();
    const delivery = message(1, Buffer.from("{bad json"));
    await harness.runtime.handleDelivery(delivery);
    assert.match(harness.failures[0]?.messageId ?? "", /^message-/);
    assert.deepEqual(harness.channel.nacked, [
      { message: delivery, allUpTo: false, requeue: false }
    ]);
  });

  it("requeues the original if failure recording fails", async () => {
    const harness = createHarness({
      error: new Error("database unavailable"),
      failureError: new Error("failure table unavailable")
    });
    const delivery = message();
    await harness.runtime.handleDelivery(delivery);
    assert.deepEqual(harness.channel.nacked, [
      { message: delivery, allUpTo: false, requeue: true }
    ]);
  });

  it("requeues the original if confirmed retry publication fails", async () => {
    const harness = createHarness({
      error: new Error("database unavailable"),
      publishError: new Error("broker unavailable")
    });
    const delivery = message();
    await harness.runtime.handleDelivery(delivery);
    assert.deepEqual(harness.channel.nacked, [
      { message: delivery, allUpTo: false, requeue: true }
    ]);
  });
});

function createHarness(
  options: {
    result?: AnalysisRunExpansionResult;
    error?: Error;
    failureError?: Error;
    publishError?: Error;
  } = {}
) {
  const channel = new FakeChannel(options.publishError);
  const failures: RecordWorkerFailure[] = [];
  const runtime = new AnalysisRunWorkerRuntime(
    channel as never,
    {
      async process() {
        if (options.error) {
          throw options.error;
        }
        return options.result ?? { outcome: "expanded", itemCount: 1 };
      }
    },
    {
      async createOrReuse(input) {
        if (options.failureError) {
          throw options.failureError;
        }
        failures.push(input);
        return {} as never;
      }
    },
    { mainExchange: "test.main", prefetch: 7 },
    { info() {}, warn() {}, error() {} }
  );
  return { runtime, channel, failures };
}

class FakeChannel {
  acked: ConsumeMessage[] = [];
  nacked: Array<{
    message: ConsumeMessage;
    allUpTo: boolean;
    requeue: boolean;
  }> = [];
  published: Array<{
    exchange: string;
    routingKey: string;
    options: Record<string, any>;
  }> = [];
  consumedQueue: string | null = null;
  prefetchCount: number | null = null;
  cancelledTag: string | null = null;

  constructor(private readonly publishError?: Error) {}

  async prefetch(value: number) {
    this.prefetchCount = value;
  }

  async consume(queue: string) {
    this.consumedQueue = queue;
    return { consumerTag: "consumer-1" };
  }

  async cancel(tag: string) {
    this.cancelledTag = tag;
    return {};
  }

  ack(message: ConsumeMessage) {
    this.acked.push(message);
  }

  nack(message: ConsumeMessage, allUpTo: boolean, requeue: boolean) {
    this.nacked.push({ message, allUpTo, requeue });
  }

  publish(
    exchange: string,
    routingKey: string,
    _content: Buffer,
    options: Record<string, any>,
    callback: (error: Error | null) => void
  ) {
    this.published.push({ exchange, routingKey, options });
    callback(this.publishError ?? null);
    return true;
  }
}

function message(attempt = 1, content = Buffer.from(JSON.stringify(validEnvelope()))) {
  return {
    content,
    fields: {} as ConsumeMessage["fields"],
    properties: {
      contentType: "application/json",
      contentEncoding: "utf-8",
      headers: { "x-worker-attempt": attempt },
      deliveryMode: 2,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: `message-${attempt}`,
      timestamp: 1,
      type: "analysis_run.created",
      userId: undefined,
      appId: undefined,
      clusterId: undefined
    }
  } as ConsumeMessage;
}

function validEnvelope() {
  return {
    messageId: "analysis_run.created:1",
    eventType: "analysis_run.created",
    aggregateType: "analysis_run",
    aggregateId: "1",
    occurredAt: "2026-07-25T00:00:00.000Z",
    attempt: 1,
    payload: {
      analysisRunId: "1",
      startingEntityPathId: "2",
      actorType: "anonymous" as const,
      userId: null,
      workspaceId: null,
      anonymousSessionId: "3"
    }
  };
}
