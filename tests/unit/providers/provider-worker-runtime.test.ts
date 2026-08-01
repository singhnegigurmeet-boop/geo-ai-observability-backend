import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsumeMessage } from "amqplib";
import { ProviderExecutionError } from "../../../src/modules/providers/errors/provider-execution.error.js";
import { ProviderWorkerRuntime } from "../../../src/modules/providers/runtime/provider-worker.runtime.js";

describe("real provider retry and DLQ routing", () => {
  it("records and republishes timeout, rate-limit, and 5xx errors", async () => {
    for (const code of [
      "PROVIDER_TIMEOUT",
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_UNAVAILABLE"
    ]) {
      const harness = createHarness(new ProviderExecutionError(code, "temporary"));
      const delivery = message();
      await harness.runtime.handleDelivery(delivery);
      assert.equal(harness.failures[0]?.errorCode, code);
      assert.equal(harness.channel.published.length, 1);
      assert.deepEqual(harness.channel.acked, [delivery]);
    }
  });

  it("rejects missing-key and invalid-model errors for DLQ without retry", async () => {
    for (const code of ["PROVIDER_API_KEY_MISSING", "UNSUPPORTED_PROVIDER_MODEL"]) {
      const harness = createHarness(new ProviderExecutionError(code, "permanent", true));
      const delivery = message();
      await harness.runtime.handleDelivery(delivery);
      assert.equal(harness.channel.published.length, 0);
      assert.deepEqual(harness.channel.nacked, [
        { message: delivery, allUpTo: false, requeue: false }
      ]);
    }
  });
});

function createHarness(error: Error) {
  const channel = new FakeChannel();
  const failures: Array<{ errorCode: string | null }> = [];
  const runtime = new ProviderWorkerRuntime(
    channel as never,
    { async process() { throw error; } },
    {
      async createOrReuse(input) {
        failures.push({ errorCode: input.errorCode });
        return {} as never;
      }
    },
    {
      queueName: "openai_queue",
      mainExchange: "test.main",
      prefetch: 2,
      workerLabel: "OpenAI provider worker"
    },
    { info() {}, warn() {}, error() {} }
  );
  return { runtime, channel, failures };
}

class FakeChannel {
  acked: ConsumeMessage[] = [];
  nacked: Array<{ message: ConsumeMessage; allUpTo: boolean; requeue: boolean }> = [];
  published: unknown[] = [];
  ack(message: ConsumeMessage) { this.acked.push(message); }
  nack(message: ConsumeMessage, allUpTo: boolean, requeue: boolean) {
    this.nacked.push({ message, allUpTo, requeue });
  }
  publish(
    exchange: string,
    routingKey: string,
    _content: Buffer,
    options: unknown,
    callback: (error: Error | null) => void
  ) {
    this.published.push({ exchange, routingKey, options });
    callback(null);
    return true;
  }
}

function message() {
  return {
    content: Buffer.from("{}"),
    fields: {} as ConsumeMessage["fields"],
    properties: {
      contentType: "application/json",
      contentEncoding: "utf-8",
      headers: { "x-worker-attempt": 1 },
      deliveryMode: 2,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: "provider-message-1",
      timestamp: 1,
      type: "provider_job.created",
      userId: undefined,
      appId: undefined,
      clusterId: undefined
    }
  } as ConsumeMessage;
}
