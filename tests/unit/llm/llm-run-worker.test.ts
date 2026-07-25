import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsumeMessage } from "amqplib";
import { LlmRunWorker } from "../../../src/modules/llm/workers/llm-run-worker.js";
import type { PromptPlanningResult } from "../../../src/modules/prompts/types/prompt.types.js";
import type { RecordWorkerFailure } from "../../../src/modules/reliability/repositories/failure-record.repository.js";
import { LlmRunWorkerRuntime } from "../../../src/modules/llm/runtime/llm-run-worker.runtime.js";

describe("LLM run worker handler", () => {
  it("passes a validated payload to prompt planning", async () => {
    const received: unknown[] = [];
    const worker = new LlmRunWorker({
      async plan(payload) {
        received.push(payload);
        return { outcome: "planned", promptJobCount: 5 };
      }
    });
    assert.deepEqual(await worker.process(validEnvelope()), {
      outcome: "planned",
      promptJobCount: 5
    });
    assert.deepEqual(received, [validEnvelope().payload]);
  });
});

describe("LLM run worker RabbitMQ reliability", () => {
  it("consumes llm_run_queue with configured prefetch", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    assert.equal(harness.channel.consumedQueue, "llm_run_queue");
    assert.equal(harness.channel.prefetchCount, 11);
    await harness.runtime.stop();
    assert.equal(harness.channel.cancelledTag, "consumer-1");
  });

  it("acknowledges planned and no-op outcomes", async () => {
    const results = [
      { outcome: "planned", promptJobCount: 5 },
      { outcome: "noop", promptJobCount: 0 }
    ] satisfies PromptPlanningResult[];
    for (const result of results) {
      const harness = createHarness({ result });
      const delivery = message();
      await harness.runtime.handleDelivery(delivery);
      assert.deepEqual(harness.channel.acked, [delivery]);
    }
  });

  it("republishes attempts 1 and 2 with incremented worker attempts", async () => {
    for (const attempt of [1, 2]) {
      const harness = createHarness({ error: new Error("database unavailable") });
      const delivery = message(attempt);
      await harness.runtime.handleDelivery(delivery);
      assert.equal(harness.failures[0]?.attemptNumber, attempt);
      assert.equal(harness.channel.published[0]?.routingKey, "llm_run_queue");
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
    assert.equal(exhausted.channel.nacked[0]?.requeue, false);

    const malformed = createHarness();
    const malformedDelivery = message(1, Buffer.from("{bad json"));
    await malformed.runtime.handleDelivery(malformedDelivery);
    assert.equal(malformed.channel.nacked[0]?.requeue, false);
  });

  it("requeues when failure recording or retry publication fails", async () => {
    const recording = createHarness({
      error: new Error("worker failed"),
      failureError: new Error("failure storage failed")
    });
    await recording.runtime.handleDelivery(message());
    assert.equal(recording.channel.nacked[0]?.requeue, true);

    const publication = createHarness({
      error: new Error("worker failed"),
      publishError: new Error("broker failed")
    });
    await publication.runtime.handleDelivery(message());
    assert.equal(publication.channel.nacked[0]?.requeue, true);
  });

  it("waits for in-flight planning during graceful shutdown", async () => {
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
    release();
    await stopping;
    assert.equal(stopped, true);
    assert.deepEqual(harness.channel.acked, [delivery]);
  });
});

function createHarness(
  options: {
    result?: PromptPlanningResult;
    error?: Error;
    failureError?: Error;
    publishError?: Error;
    waitFor?: Promise<void>;
  } = {}
) {
  const channel = new FakeChannel(options.publishError);
  const failures: RecordWorkerFailure[] = [];
  const runtime = new LlmRunWorkerRuntime(
    channel as never,
    {
      async process() {
        if (options.waitFor) await options.waitFor;
        if (options.error) throw options.error;
        return options.result ?? {
          outcome: "planned",
          promptJobCount: 5
        };
      }
    },
    {
      async createOrReuse(input) {
        if (options.failureError) throw options.failureError;
        failures.push(input);
        return {} as never;
      }
    },
    { mainExchange: "test.main", prefetch: 11 },
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
      messageId: `llm-message-${attempt}`,
      timestamp: 1,
      type: "llm_run.created",
      userId: undefined,
      appId: undefined,
      clusterId: undefined
    }
  } as ConsumeMessage;
}

function validEnvelope() {
  return {
    messageId: "llm_run.created:4",
    eventType: "llm_run.created",
    aggregateType: "llm_run",
    aggregateId: "4",
    occurredAt: "2026-07-25T00:00:00.000Z",
    attempt: 1,
    payload: { llmRunId: "4" }
  };
}
