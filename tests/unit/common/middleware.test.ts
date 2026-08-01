import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { describe, it } from "node:test";
import { z } from "zod";
import { ApplicationError } from "../../../src/common/errors/application-error.js";
import { errorMiddleware } from "../../../src/common/middleware/error.middleware.js";

type CapturedResponse = {
  statusCode: number | null;
  body: unknown;
};

describe("error middleware", () => {
  it("returns 400 for Zod validation failures", () => {
    const captured = captureError(z.string().min(1).safeParse("").error);

    assert.equal(captured.statusCode, 400);
    assert.equal(
      (captured.body as { status: string; code: string }).status,
      "error"
    );
    assert.equal(
      (captured.body as { status: string; code: string }).code,
      "VALIDATION_ERROR"
    );
  });

  it("returns stable categories and safe messages for application errors", () => {
    const captured = captureError(
      new ApplicationError("CONFLICT", "Safe conflict message")
    );

    assert.equal(captured.statusCode, 409);
    assert.deepEqual(captured.body, {
      status: "error",
      code: "CONFLICT",
      error: "Safe conflict message",
      details: { category: "CONFLICT" }
    });
  });

  it("maps viewer mutation denials to HTTP 403", () => {
    const captured = captureError(
      new ApplicationError("FORBIDDEN", "Workspace role does not permit mutations")
    );

    assert.equal(captured.statusCode, 403);
    assert.equal((captured.body as { code: string }).code, "FORBIDDEN");
  });

  it("does not expose unexpected internal error details", () => {
    const captured = captureError(
      new Error("password=secret; relation internal_table does not exist")
    );

    assert.equal(captured.statusCode, 500);
    assert.deepEqual(captured.body, {
      status: "error",
      code: "INTERNAL_ERROR",
      error: "An unexpected internal error occurred."
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
