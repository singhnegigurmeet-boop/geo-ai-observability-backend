import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { describe, it } from "node:test";
import { z } from "zod";
import { errorMiddleware } from "../src/middleware/error.middleware.js";

type CapturedResponse = {
  statusCode: number | null;
  body: unknown;
};

describe("error middleware", () => {
  it("returns 400 for Zod validation failures", () => {
    const captured = captureError(z.string().min(1).safeParse("").error);

    assert.equal(captured.statusCode, 400);
    assert.equal((captured.body as { status: string }).status, "error");
  });

  it("returns 500 for unexpected errors", () => {
    const captured = captureError(new Error("Unexpected test failure"));

    assert.equal(captured.statusCode, 500);
    assert.deepEqual(captured.body, {
      status: "error",
      error: "Unexpected test failure"
    });
  });
});

function captureError(error: unknown): CapturedResponse {
  const captured: CapturedResponse = {
    statusCode: null,
    body: null
  };

  const response = {
    status(statusCode: number) {
      captured.statusCode = statusCode;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    }
  } as unknown as Response;

  errorMiddleware(
    error,
    {} as Request,
    response,
    (() => undefined) as NextFunction
  );

  return captured;
}
