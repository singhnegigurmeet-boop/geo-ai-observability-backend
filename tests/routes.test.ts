import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";

describe("Production Core shell routes", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = await new Promise<Server>((resolve) => {
      const listeningServer = createApp().listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected the test server to listen on a TCP port");
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
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

  it("GET /openapi.json documents only the shell health API", async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    const document = (await response.json()) as {
      info: { version: string };
      paths: Record<string, unknown>;
    };

    assert.equal(response.status, 200);
    assert.equal(document.info.version, "0.1.0-phase1");
    assert.deepEqual(Object.keys(document.paths), ["/health"]);
  });

  it("GET /docs serves Swagger UI", async () => {
    const response = await fetch(`${baseUrl}/docs/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(body, /Swagger UI/);
  });

  it("does not expose removed analysis or discovery APIs", async () => {
    const analysisResponse = await fetch(`${baseUrl}/v1/analysis`);
    const discoveryResponse = await fetch(`${baseUrl}/v1/discovery`);

    assert.equal(analysisResponse.status, 404);
    assert.equal(discoveryResponse.status, 404);
  });
});
