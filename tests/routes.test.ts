import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { Router } from "express";
import { createApp } from "../src/app.js";

describe("Production Core shell routes", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const protectedAnalysisRouter = Router();
    protectedAnalysisRouter.use((_request, response) => {
      response.status(401).json({ status: "error" });
    });
    server = await new Promise<Server>((resolve) => {
      const listeningServer = createApp({
        analysisRouter: protectedAnalysisRouter,
        readinessService: {
          async check() {
            return {
              status: "ready",
              checks: {
                database: { status: "ok" },
                migrations: { status: "ok" },
                rabbitmq: { status: "ok" },
                queues: { status: "ok" }
              }
            };
          }
        }
      }).listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the test server to listen on a TCP port");
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  it("GET /ready reports dependency readiness", async () => {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json() as { status: string }).status,
      "ready"
    );
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });

  it("GET /health returns process health", async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("GET /openapi.json documents the current analysis HTTP surface", async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    const document = (await response.json()) as {
      info: { version: string };
      paths: Record<string, unknown>;
    };

    assert.equal(response.status, 200);
    assert.equal(document.info.version, "0.1.0-phase12");
    assert.deepEqual(Object.keys(document.paths), [
      "/health",
      "/ready",
      "/v1/analysis",
      "/v1/analysis/runs/{analysisRunId}",
      "/v1/analysis/runs/{analysisRunId}/report"
    ]);
  });

  it("GET /docs serves Swagger UI", async () => {
    const response = await fetch(`${baseUrl}/docs/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(body, /Swagger UI/);
  });

  it("protects analysis while leaving removed discovery unavailable", async () => {
    const analysisResponse = await fetch(`${baseUrl}/v1/analysis`, {
      method: "POST"
    });
    const discoveryResponse = await fetch(`${baseUrl}/v1/discovery`);
    const unsecuredOpsResponse = await fetch(
      `${baseUrl}/v1/internal/ops/summary`
    );

    assert.equal(analysisResponse.status, 401);
    assert.equal(discoveryResponse.status, 404);
    assert.equal(unsecuredOpsResponse.status, 404);
  });
});
