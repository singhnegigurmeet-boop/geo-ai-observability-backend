import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  QUEUE_NAMES,
  deadLetterQueueName
} from "../src/messaging/queue-names.js";
import {
  declareRabbitMqTopology,
  type TopologyChannel
} from "../src/messaging/rabbitmq.topology.js";

describe("RabbitMQ topology declaration", () => {
  it("declares every production queue, including mock and scoring, with a dedicated DLQ", async () => {
    const exchanges: Array<{ name: string; type: string; options: unknown }> = [];
    const queues: Array<{ name: string; options: Record<string, unknown> }> = [];
    const bindings: Array<{ queue: string; exchange: string; key: string }> = [];

    const channel = {
      async assertExchange(name: string, type: string, options: unknown) {
        exchanges.push({ name, type, options });
        return { exchange: name };
      },
      async assertQueue(name: string, options: Record<string, unknown>) {
        queues.push({ name, options });
        return { queue: name, messageCount: 0, consumerCount: 0 };
      },
      async bindQueue(queue: string, exchange: string, key: string) {
        bindings.push({ queue, exchange, key });
        return {};
      }
    } as unknown as TopologyChannel;

    await declareRabbitMqTopology(channel, {
      mainExchange: "test.main",
      deadLetterExchange: "test.dlx"
    });

    assert.deepEqual(
      exchanges.map(({ name, type }) => ({ name, type })),
      [
        { name: "test.main", type: "direct" },
        { name: "test.dlx", type: "direct" }
      ]
    );
    assert.equal(queues.length, QUEUE_NAMES.length * 2);
    assert.equal(bindings.length, QUEUE_NAMES.length * 2);
    assert.ok(QUEUE_NAMES.includes("mock_queue"));
    assert.ok(QUEUE_NAMES.includes("scoring_queue"));

    for (const queueName of QUEUE_NAMES) {
      const dlqName = deadLetterQueueName(queueName);
      const mainQueue = queues.find((queue) => queue.name === queueName);
      const dlq = queues.find((queue) => queue.name === dlqName);

      assert.ok(mainQueue);
      assert.ok(dlq);
      assert.equal(mainQueue.options.durable, true);
      assert.equal(dlq.options.durable, true);
      assert.deepEqual(mainQueue.options.arguments, {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "test.dlx",
        "x-dead-letter-routing-key": dlqName
      });
      assert.deepEqual(dlq.options.arguments, {
        "x-queue-type": "quorum"
      });
      assert.ok(
        bindings.some(
          (binding) =>
            binding.queue === queueName &&
            binding.exchange === "test.main" &&
            binding.key === queueName
        )
      );
      assert.ok(
        bindings.some(
          (binding) =>
            binding.queue === dlqName &&
            binding.exchange === "test.dlx" &&
            binding.key === dlqName
        )
      );
    }
  });
});
