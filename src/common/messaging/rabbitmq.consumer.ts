import type {
  ConfirmChannel,
  ConsumeMessage,
  Options,
  Replies
} from "amqplib";

export const WORKER_ATTEMPT_HEADER = "x-worker-attempt";

export type ConsumerChannel = Pick<
  ConfirmChannel,
  "ack" | "cancel" | "consume" | "nack" | "prefetch" | "publish"
>;

export async function publishConfirmed(
  channel: Pick<ConfirmChannel, "publish">,
  exchange: string,
  routingKey: string,
  content: Buffer,
  options: Options.Publish
) {
  await new Promise<void>((resolve, reject) => {
    channel.publish(
      exchange,
      routingKey,
      content,
      options,
      (error) => (error ? reject(error) : resolve())
    );
  });
}

export async function startConsumer(
  channel: ConsumerChannel,
  queueName: string,
  prefetch: number,
  handler: (message: ConsumeMessage) => Promise<void>
): Promise<Replies.Consume> {
  await channel.prefetch(prefetch);
  return channel.consume(
    queueName,
    (message) => {
      if (message) {
        void handler(message);
      }
    },
    { noAck: false }
  );
}

export function readWorkerAttempt(message: ConsumeMessage) {
  const value = message.properties.headers?.[WORKER_ATTEMPT_HEADER];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 3
    ? value
    : 1;
}
