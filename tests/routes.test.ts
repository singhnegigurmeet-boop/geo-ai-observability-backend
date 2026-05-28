import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import type { AnalysisRequest } from "../src/modules/analysis/types/v6-analysis-request.js";
import type { DiscoveryRequest } from "../src/modules/discovery/types/discovery-request.js";

const analysisRunId = 10;

const fakeAnalysisCommandService = {
  async enqueueAnalysis(request: AnalysisRequest) {
    return {
      statusCode: 501,
      body: {
        status: "not_implemented",
        code: "V6_ANALYSIS_REBUILD_REQUIRED",
        domain: request.domain,
        selection: { categories: request.categories ?? [] }
      }
    };
  }
};

const fakeAnalysisStatusService = {
  async getAnalysisRunStatus(requestedAnalysisRunId: number) {
    return {
      statusCode: 501,
      body: {
        status: "not_implemented",
        analysis_run_id: requestedAnalysisRunId
      }
    };
  },

  async getAnalysisRunDiffs(requestedAnalysisRunId: number) {
    return {
      statusCode: 501,
      body: {
        status: "not_implemented",
        analysis_run_id: requestedAnalysisRunId
      }
    };
  }
};

const fakeDiscoveryCommandService = {
  async createDiscoveryRequest(request: DiscoveryRequest) {
    return {
      statusCode: 501,
      body: {
        status: "not_implemented",
        code: "V6_DISCOVERY_REBUILD_REQUIRED",
        request
      }
    };
  }
};

describe("routes", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = createApp({
      analysisCommandService: fakeAnalysisCommandService,
      analysisStatusService: fakeAnalysisStatusService,
      discoveryCommandService: fakeDiscoveryCommandService
    });
    server = app.listen(0);

    await new Promise<void>((resolve) => server.once("listening", resolve));

    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("GET /health returns ok", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: "ok" });
  });

  it("GET /openapi.json returns the V6 placeholder API spec", async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.openapi, "3.0.3");
    assert.ok(body.paths["/v1/analysis"]);
    assert.ok(body.paths["/v1/discovery"]);
    assert.equal(body.paths["/v1/schedules"], undefined);
    assert.equal(body.paths["/v1/domains/{domainId}/provider-scores"], undefined);
  });

  it("GET /docs serves Swagger UI", async () => {
    const response = await fetch(`${baseUrl}/docs/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /swagger-ui/i);
  });

  it("POST /v1/analysis accepts the frozen V6 request shape as a placeholder", async () => {
    const response = await fetch(`${baseUrl}/v1/analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "nike.com",
        categories: [
          {
            categoryId: 1,
            brands: [
              {
                brandId: 2,
                products: [{ productId: 3, useContextIds: [4, 5] }]
              }
            ]
          }
        ]
      })
    });
    const body = await response.json();

    assert.equal(response.status, 501);
    assert.equal(body.status, "not_implemented");
    assert.equal(body.code, "V6_ANALYSIS_REBUILD_REQUIRED");
    assert.equal(body.selection.categories[0].categoryId, 1);
  });

  it("POST /v1/analysis rejects free-text brand fields", async () => {
    const response = await fetch(`${baseUrl}/v1/analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        domain: "nike.com",
        categories: [{ categoryId: 1, brands: [{ brandName: "Nike" }] }]
      })
    });

    assert.equal(response.status, 400);
  });

  it("POST /v1/discovery accepts free-text missing-data requests without running analysis", async () => {
    const response = await fetch(`${baseUrl}/v1/discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "product",
        domain: "nike.com",
        productName: "Pegasus 41",
        categoryId: 1
      })
    });
    const body = await response.json();

    assert.equal(response.status, 501);
    assert.equal(body.code, "V6_DISCOVERY_REBUILD_REQUIRED");
    assert.equal(body.request.kind, "product");
    assert.equal(body.request.productName, "Pegasus 41");
  });

  it("GET /v1/analysis/runs/:analysisRunId returns the V6 status placeholder", async () => {
    const response = await fetch(`${baseUrl}/v1/analysis/runs/${analysisRunId}`);
    const body = await response.json();

    assert.equal(response.status, 501);
    assert.equal(body.status, "not_implemented");
    assert.equal(body.analysis_run_id, analysisRunId);
  });

  it("old V5 public read and scheduler routes are not active", async () => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/v1/schedules`),
      fetch(`${baseUrl}/v1/domains/1/provider-scores`),
      fetch(`${baseUrl}/v1/domains/1/visibility-score`),
      fetch(`${baseUrl}/v1/domains/1/providers/openai/scores`)
    ]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [404, 404, 404, 404]
    );
  });
});

