import amqp, {
  type ChannelModel,
  type ConfirmChannel
} from "amqplib";

export type RabbitMqConnectionOptions = {
  url: string;
  initializeChannel?: (channel: ConfirmChannel) => Promise<void>;
};

export class RabbitMqConnection {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private connecting: Promise<ConfirmChannel> | null = null;
  private closing = false;

  constructor(private readonly options: RabbitMqConnectionOptions) {}

  async getConfirmChannel() {
    if (this.closing) {
      throw new Error("RabbitMQ connection is shutting down");
    }
    if (this.channel) {
      return this.channel;
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async close() {
    this.closing = true;
    const pendingConnection = this.connecting;
    if (pendingConnection) {
      await pendingConnection.catch(() => undefined);
    }

    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;

    if (channel) {
      await channel.close().catch(() => undefined);
    }
    if (connection) {
      await connection.close().catch(() => undefined);
    }
  }

  private async connect() {
    const connection = await amqp.connect(this.options.url);
    this.connection = connection;

    connection.on("error", (error) => {
      console.error("RabbitMQ connection error.", error);
    });
    connection.on("close", () => {
      if (this.connection === connection) {
        this.connection = null;
        this.channel = null;
      }
    });

    try {
      const channel = await connection.createConfirmChannel();
      channel.on("error", (error) => {
        console.error("RabbitMQ confirm channel error.", error);
      });
      channel.on("close", () => {
        if (this.channel === channel) {
          this.channel = null;
        }
        if (!this.closing && this.connection === connection) {
          this.connection = null;
          connection.close().catch(() => undefined);
        }
      });

      if (this.options.initializeChannel) {
        await this.options.initializeChannel(channel);
      }
      this.channel = channel;
      return channel;
    } catch (error) {
      if (this.connection === connection) {
        this.connection = null;
      }
      await connection.close().catch(() => undefined);
      throw error;
    }
  }
}
