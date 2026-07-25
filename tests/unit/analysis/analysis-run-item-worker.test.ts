import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsumeMessage } from "amqplib";
import { AnalysisRunItemWorker } from "../../../src/modules/analysis/workers/analysis-run-item-worker.js";
import type { LlmRunCreationResult } from "../../../src/modules/llm/types/llm-run.types.js";
import type { RecordWorkerFailure } from "../../../src/modules/reliability/repositories/failure-record.repository.js";
import { AnalysisRunItemWorkerRuntime } from "../../../src/modules/analysis/runtime/analysis-run-item-worker.runtime.js";

describe("analysis run item worker handler", () => {
  it("passes the validated payload to LLM-run creation", async () => {
    const received: unknown[] = [];
    const worker = new AnalysisRunItemWorker({
      async create(payload) {
        received.push(payload);
        return { outcome: "created", llmRunId: "10" };
      }
    });
    assert.deepEqual(await worker.process(validEnvelope()), {
      outcome: "created",
      llmRunId: "10"
    });
    assert.deepEqual(received, [validEnvelope().payload]);
  });
});

describe("analysis run item worker RabbitMQ reliability", () => {
  it("consumes analysis_run_item_queue with configured prefetch", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    assert.equal(harness.channel.consumedQueue, "analysis_run_item_queue");
    assert.equal(harness.channel.prefetchCount, 9);
    await harness.runtime.stop();
    assert.equal(harness.channel.cancelledTag, "consumer-1");
  });

  it("acknowledges successful and no-op outcomes", async () => {
    const results = [
      { outcome: "created", llmRunId: "10" },
      { outcome: "noop", llmRunId: null }
    ] satisfies LlmRunCreationResult[];
    for (const result of results) {
      const harness = createHarness({ result });
      const delivery = message();
      await harness.runtime.handleDelivery(delivery);
      assert.deepEqual(harness.channel.acked, [delivery]);
    }
  });

  it("republishes attempts 1 and 2 with a separate worker-attempt header", async () => {
    for (const attempt of [1, 2]) {
      const harness = createHarness({ error: new Error("database unavailable") });
      const delivery = message(attempt);
      await harness.runtime.handleDelivery(delivery);
      assert.equal(harness.failures[0]?.attemptNumber, attempt);
      assert.equal(harness.channel.published[0]?.routingKey, "analysis_run_item_queue");
      assert.equal(
        harness.channel.published[0]?.options.headers?.["x-worker-attempt"],
        attempt + 1
      );
      assert.deepEqual(harness.channel.acked, [delivery]);
    }
  });

  it("rejects attempt 3 and malformed messages without requeue", async () => {
    const exhausted = createHarness({ error: new Error("still unavailable") });
    const exhaustedDelivery = message(3);
    await exhausted.runtime.handleDelivery(exhaustedDelivery);
    assert.deepEqual(exhausted.channel.nacked, [
      { message: exhaustedDelivery, allUpTo: false, requeue: false }
    ]);

    const malformed = createHarness();
    const malformedDelivery = message(1, Buffer.from("{bad json"));
    await malformed.runtime.handleDelivery(malformedDelivery);
    assert.deepEqual(malformed.channel.nacked, [
      { message: malformedDelivery, allUpTo: false, requeue: false }
    ]);
  });

  it("requeues when failure recording or retry publication fails", async () => {
    const recording = createHarness({
      error: new Error("worker failed"),
      failureError: new Error("failure storage failed")
    });
    const recordingDelivery = message();
    await recording.runtime.handleDelivery(recordingDelivery);
    assert.equal(recording.channel.nacked[0]?.requeue, true);

    const publication = createHarness({
      error: new Error("worker failed"),
      publishError: new Error("broker failed")
    });
    const publicationDelivery = message();
    await publication.runtime.handleDelivery(publicationDelivery);
    assert.equal(publication.channel.nacked[0]?.requeue, true);
  });

  it("cancels intake and waits for an in-flight delivery during shutdown", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({ waitFor: blocked });
    await harness.runtime.start();
    const delivery = message();
    harness.channel.deliver(delivery);
    await new Promise((resolve) => setImmediate(resolve));

    let stopped = false;
    const stopping = harness.runtime.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(harness.channel.cancelledTag, "consumer-1");
    release();
    await stopping;
    assert.equal(stopped, true);
    assert.deepEqual(harness.channel.acked, [delivery]);
  });
});

function createHarness(
  options: {
    result?: LlmRunCreationResult;
    error?: Error;
    failureError?: Error;
    publishError?: Error;
    waitFor?: Promise<void>;
  } = {}
) {
  const channel = new FakeChannel(options.publishError);
  const failures: RecordWorkerFailure[] = [];
  const runtime = new AnalysisRunItemWorkerRuntime(
    channel as never,
    {
      async process() {
        if (options.waitFor) await options.waitFor;
        if (options.error) throw options.error;
        return options.result ?? { outcome: "created", llmRunId: "10" };
      }
    },
    {
      async createOrReuse(input) {
        if (options.failureError) throw options.failureError;
        failures.push(input);
        return {} as never;
      }
    },
    { mainExchange: "test.main", prefetch: 9 },
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
    routingKey: string;
    options: Record<string, any>;
  }> = [];
  consumedQueue: string | null = null;
  prefetchCount: number | null = null;
  cancelledTag: string | null = null;
  private consumer: ((message: ConsumeMessage | null) => void) | null = null;

  constructor(private readonly publishError?: Error) {}
  async prefetch(value: number) {
    this.prefetchCount = value;
  }
  async consume(queue: string, consumer: (message: ConsumeMessage | null) => void) {
    this.consumedQueue = queue;
    this.consumer = consumer;
    return { consumerTag: "consumer-1" };
  }
  async cancel(tag: string) {
    this.cancelledTag = tag;
    return {};
  }
  deliver(value: ConsumeMessage) {
    this.consumer?.(value);
  }
  ack(value: ConsumeMessage) {
    this.acked.push(value);
  }
  nack(value: ConsumeMessage, allUpTo: boolean, requeue: boolean) {
    this.nacked.push({ message: value, allUpTo, requeue });
  }
  publish(
    _exchange: string,
    routingKey: string,
    _content: Buffer,
    options: Record<string, any>,
    callback: (error: Error | null) => void
  ) {
    this.published.push({ routingKey, options });
    callback(this.publishError ?? null);
    return true;
  }
}

function message(
  attempt = 1,
  content = Buffer.from(JSON.stringify(validEnvelope()))
) {
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
      messageId: `item-message-${attempt}`,
      timestamp: 1,
      type: "analysis_run_item.created",
      userId: undefined,
      appId: undefined,
      clusterId: undefined
    }
  } as ConsumeMessage;
}

function validEnvelope() {
  return {
    messageId: "analysis_run_item.created:4",
    eventType: "analysis_run_item.created",
    aggregateType: "analysis_run_item",
    aggregateId: "4",
    occurredAt: "2026-07-25T00:00:00.000Z",
    attempt: 1,
    payload: { analysisRunItemId: "4" }
  };
}
