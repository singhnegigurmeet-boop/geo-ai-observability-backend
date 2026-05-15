import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";

const domainId = 1;
const jobId = 10;

const fakeAnalysisCommandService = {
  async enqueueOrReturnCachedAnalysis(domain: string) {
    return {
      statusCode: 202,
      body: {
        status: "queued",
        analysis_run_id: jobId,
        domain_id: domainId,
        message: "Analysis started",
        domain
      }
    };
  }
};

const fakeAnalysisStatusService = {
  async getAnalysisJobStatus(requestedJobId: number) {
    return {
      statusCode: 200,
      body: {
        status: "completed",
        analysis_run_id: requestedJobId,
        domain: "nike.com"
      }
    };
  },

  async getAnalysisJobDiffs(requestedJobId: number) {
    return {
      statusCode: 200,
      body: {
        status: "found",
        source: "analysis_diffs",
        analysis_run_id: requestedJobId,
        domain_id: domainId,
        domain: "nike.com",
        diffs: [
          {
            diff_type: "visibility_score_dropped",
            severity: "warning"
          }
        ]
      }
    };
  }
};

const fakeProviderScoresService = {
  async getLatestProviderScores(requestedDomainId: number, llmName: string) {
    return {
      statusCode: 200,
      body: {
        domain_id: requestedDomainId,
        domain: "nike.com",
        provider: llmName,
        scores: [
          {
            top_k: 5,
            rank_position: 2,
            mention_count: 1,
            score: "92.00",
            status: "completed"
          }
        ]
      }
    };
  },

  async getLatestProviderScoreComparison(requestedDomainId: number) {
    return {
      statusCode: 200,
      body: {
        domain_id: requestedDomainId,
        domain: "nike.com",
        providers: {
          openai: [{ top_k: 5, score: "92.00", status: "completed" }],
          gemini: [{ top_k: 5, score: "80.00", status: "completed" }],
          claude: [{ top_k: 5, score: "88.00", status: "completed" }]
        }
      }
    };
  },

  async getProviderScoreHistory(requestedDomainId: number, llmName: string) {
    return {
      statusCode: 200,
      body: {
        domain_id: requestedDomainId,
        domain: "nike.com",
        provider: llmName,
        history: [{ top_k: 5, score: "92.00", status: "completed" }]
      }
    };
  }
};

const fakeVisibilityScoreReadService = {
  async getLatestVisibilityScore(requestedDomainId: number) {
    return {
      statusCode: 200,
      body: {
        domain_id: requestedDomainId,
        domain: "nike.com",
        data: {
          overall_geo_score: "86.67"
        }
      }
    };
  },

  async getVisibilityScoreHistory(requestedDomainId: number) {
    return {
      statusCode: 200,
      body: {
        domain_id: requestedDomainId,
        domain: "nike.com",
        history: [{ overall_geo_score: "86.67" }]
      }
    };
  },

  async getVisibilityScoreTrend(requestedDomainId: number) {
    return {
      statusCode: 200,
      body: {
        domain_id: requestedDomainId,
        domain: "nike.com",
        current_score: 86.67,
        previous_score: 80,
        change: 6.67,
        trend: "improved"
      }
    };
  }
};

const fakeScheduleManagementService = {
  async upsertSchedule(input: { domain: string; enabled: boolean }) {
    return {
      statusCode: 200,
      body: {
        status: "scheduled",
        source: "domain_schedules",
        schedule: {
          id: 7,
          domain_id: domainId,
          domain: input.domain,
          cadence: "weekly",
          enabled: input.enabled
        }
      }
    };
  },

  async listSchedules() {
    return {
      statusCode: 200,
      body: {
        status: "found",
        source: "domain_schedules",
        schedules: [
          {
            id: 7,
            domain_id: domainId,
            domain: "nike.com",
            cadence: "weekly",
            enabled: true
          }
        ]
      }
    };
  },

  async setScheduleEnabled(scheduleId: number, enabled: boolean) {
    return {
      statusCode: 200,
      body: {
        status: enabled ? "enabled" : "disabled",
        source: "domain_schedules",
        schedule: {
          id: scheduleId,
          enabled
        }
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
      providerScoresService: fakeProviderScoresService,
      scheduleManagementService: fakeScheduleManagementService,
      visibilityScoreReadService: fakeVisibilityScoreReadService
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

  it("GET /openapi.json returns the API spec", async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.openapi, "3.0.3");
    assert.ok(body.paths["/v1/analysis"]);
  });

  it("GET /docs serves Swagger UI", async () => {
    const response = await fetch(`${baseUrl}/docs/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /swagger-ui/i);
  });

  it("POST /v1/analysis queues an analysis", async () => {
    const response = await fetch(`${baseUrl}/v1/analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "nike.com" })
    });
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.status, "queued");
    assert.equal(body.analysis_run_id, jobId);
    assert.equal(body.domain_id, domainId);
  });

  it("GET /v1/analysis/jobs/:jobId returns job status", async () => {
    const response = await fetch(`${baseUrl}/v1/analysis/jobs/${jobId}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "completed");
    assert.equal(body.analysis_run_id, jobId);
  });

  it("GET /v1/analysis/jobs/:jobId/diffs returns analysis diffs", async () => {
    const response = await fetch(`${baseUrl}/v1/analysis/jobs/${jobId}/diffs`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.source, "analysis_diffs");
    assert.equal(body.analysis_run_id, jobId);
    assert.equal(body.diffs[0].diff_type, "visibility_score_dropped");
  });

  it("POST /v1/schedules creates or updates a schedule", async () => {
    const response = await fetch(`${baseUrl}/v1/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "nike.com", enabled: true })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.source, "domain_schedules");
    assert.equal(body.schedule.domain, "nike.com");
  });

  it("GET /v1/schedules lists schedules", async () => {
    const response = await fetch(`${baseUrl}/v1/schedules`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.schedules[0].domain, "nike.com");
  });

  it("PATCH /v1/schedules/:scheduleId enables or disables a schedule", async () => {
    const response = await fetch(`${baseUrl}/v1/schedules/7`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "disabled");
    assert.equal(body.schedule.id, 7);
  });

  it("GET /v1/domains/:domainId/providers/:llmName/scores returns one provider", async () => {
    const response = await fetch(`${baseUrl}/v1/domains/${domainId}/providers/openai/scores`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.domain_id, domainId);
    assert.equal(body.provider, "openai");
    assert.equal(body.scores[0].top_k, 5);
  });

  it("GET /v1/domains/:domainId/provider-scores returns provider comparison", async () => {
    const response = await fetch(`${baseUrl}/v1/domains/${domainId}/provider-scores`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.domain_id, domainId);
    assert.ok(body.providers.openai);
    assert.ok(body.providers.gemini);
    assert.ok(body.providers.claude);
  });

  it("GET /v1/domains/:domainId/visibility-score returns final score", async () => {
    const response = await fetch(`${baseUrl}/v1/domains/${domainId}/visibility-score`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.domain_id, domainId);
    assert.equal(body.data.overall_geo_score, "86.67");
  });

  it("GET /v1/domains/:domainId/visibility-score/history returns visibility history", async () => {
    const response = await fetch(`${baseUrl}/v1/domains/${domainId}/visibility-score/history`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.domain_id, domainId);
    assert.equal(body.history[0].overall_geo_score, "86.67");
  });

  it("GET /v1/domains/:domainId/providers/:llmName/history returns provider history", async () => {
    const response = await fetch(`${baseUrl}/v1/domains/${domainId}/providers/openai/history`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.domain_id, domainId);
    assert.equal(body.provider, "openai");
    assert.equal(body.history[0].top_k, 5);
  });

  it("GET /v1/domains/:domainId/visibility-score/trend returns trend summary", async () => {
    const response = await fetch(`${baseUrl}/v1/domains/${domainId}/visibility-score/trend`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.domain_id, domainId);
    assert.equal(body.trend, "improved");
    assert.equal(body.change, 6.67);
  });

  it("rejects an invalid provider name", async () => {
    const response = await fetch(`${baseUrl}/v1/domains/${domainId}/providers/not-a-provider/scores`);
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, "Invalid request body");
  });
});
