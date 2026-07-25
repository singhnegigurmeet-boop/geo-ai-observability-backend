import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidNotificationMessageError,
  parseNotificationCreatedMessage
} from "../src/notifications/notification-worker.messages.js";
import { NotificationWorker } from "../src/notifications/notification-worker.js";

const validMessage = {
  messageId: "notification.created:9",
  eventType: "notification.created",
  aggregateType: "notification",
  aggregateId: "9",
  occurredAt: "2026-07-25T00:00:00.000Z",
  attempt: 1,
  payload: {
    notificationId: "9",
    analysisRunId: "7",
    failureRecordId: null,
    isAdmin: false
  }
};

describe("notification worker messages", () => {
  it("accepts the strict ID-only envelope and delegates the payload", async () => {
    const received: unknown[] = [];
    const worker = new NotificationWorker({
      async deliverInternal(payload) {
        received.push(payload);
        return { outcome: "sent" as const, notificationId: payload.notificationId };
      }
    });
    await worker.process(validMessage);
    assert.deepEqual(received, [validMessage.payload]);
  });

  it("rejects body data, mismatched IDs, and malformed IDs permanently", () => {
    for (const message of [
      { ...validMessage, report: { private: true } },
      { ...validMessage, aggregateId: "10" },
      {
        ...validMessage,
        payload: { ...validMessage.payload, notificationId: "not-an-id" }
      }
    ]) {
      assert.throws(
        () => parseNotificationCreatedMessage(message),
        InvalidNotificationMessageError
      );
    }
  });
});
