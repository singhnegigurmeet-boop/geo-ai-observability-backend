import type { Channel } from "amqplib";
import {
  QUEUE_NAMES,
  deadLetterQueueName
} from "./queue-names.js";

export type RabbitMqTopologyConfig = {
  mainExchange: string;
  deadLetterExchange: string;
};

export type TopologyChannel = Pick<
  Channel,
  "assertExchange" | "assertQueue" | "bindQueue"
>;

export async function declareRabbitMqTopology(
  channel: TopologyChannel,
  config: RabbitMqTopologyConfig
) {
  await channel.assertExchange(config.mainExchange, "direct", {
    durable: true,
    autoDelete: false
  });
  await channel.assertExchange(config.deadLetterExchange, "direct", {
    durable: true,
    autoDelete: false
  });

  for (const queueName of QUEUE_NAMES) {
    const dlqName = deadLetterQueueName(queueName);

    await channel.assertQueue(dlqName, {
      durable: true,
      exclusive: false,
      autoDelete: false,
      arguments: {
        "x-queue-type": "quorum"
      }
    });
    await channel.bindQueue(
      dlqName,
      config.deadLetterExchange,
      dlqName
    );

    await channel.assertQueue(queueName, {
      durable: true,
      exclusive: false,
      autoDelete: false,
      arguments: {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": config.deadLetterExchange,
        "x-dead-letter-routing-key": dlqName
      }
    });
    await channel.bindQueue(queueName, config.mainExchange, queueName);
  }
}
