import type {
  ConfirmChannel,
  ConsumeMessage
} from "amqplib";
import type { QueueMessage } from "./queue-message.types.js";
import type { QueueName } from "./queue-names.js";
import type { RabbitMqConnection } from "./rabbitmq.connection.js";

export type RabbitMqPublisherOptions = {
  exchange: string;
  confirmTimeoutMs: number;
};

export class UnroutableMessageError extends Error {
  readonly code = "RABBITMQ_UNROUTABLE";

  constructor(messageId: string) {
    super(`RabbitMQ could not route message ${messageId}`);
    this.name = "UnroutableMessageError";
  }
}

export class RabbitMqPublisher {
  private readonly returnedMessageIds = new WeakMap<ConfirmChannel, Set<string>>();

  constructor(
    private readonly connection: Pick<RabbitMqConnection, "getConfirmChannel">,
    private readonly options: RabbitMqPublisherOptions
  ) {}

  async publish(queueName: QueueName, message: QueueMessage) {
    const channel = await this.connection.getConfirmChannel();
    const returned = this.trackReturnedMessages(channel);
    const content = Buffer.from(JSON.stringify(message));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          channel.close().catch(() => undefined);
          reject(new Error(`RabbitMQ confirm timed out for ${message.messageId}`));
        }
      }, this.options.confirmTimeoutMs);

      channel.publish(
        this.options.exchange,
        queueName,
        content,
        {
          mandatory: true,
          persistent: true,
          contentType: "application/json",
          contentEncoding: "utf-8",
          messageId: message.messageId,
          type: message.eventType,
          timestamp: Math.floor(Date.parse(message.occurredAt) / 1_000),
          headers: {
            aggregateType: message.aggregateType,
            aggregateId: message.aggregateId,
            attempt: message.attempt
          }
        },
        (error) => {
          setImmediate(() => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeout);
            const wasReturned = returned.delete(message.messageId);

            if (error) {
              reject(error);
              return;
            }
            if (wasReturned) {
              reject(new UnroutableMessageError(message.messageId));
              return;
            }
            resolve();
          });
        }
      );
    });
  }

  private trackReturnedMessages(channel: ConfirmChannel) {
    const existing = this.returnedMessageIds.get(channel);
    if (existing) {
      return existing;
    }

    const returned = new Set<string>();
    channel.on("return", (message: ConsumeMessage) => {
      const messageId = message.properties.messageId;
      if (messageId) {
        returned.add(messageId);
      }
    });
    this.returnedMessageIds.set(channel, returned);
    return returned;
  }
}
