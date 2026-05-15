export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "GEO AI Observability Backend API",
    version: "0.1.0",
    description: "Domain-only GEO visibility analysis API with async job polling and provider score reads."
  },
  servers: [
    {
      url: "http://127.0.0.1:4000",
      description: "Local development"
    }
  ],
  tags: [
    { name: "Health" },
    { name: "Analysis" },
    { name: "Provider Scores" },
    { name: "Visibility Scores" }
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Check API health",
        responses: {
          "200": {
            description: "API is healthy",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" }
              }
            }
          }
        }
      }
    },
    "/v1/analysis": {
      post: {
        tags: ["Analysis"],
        summary: "Queue domain analysis or return cached/fresh result",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AnalysisRequest" },
              examples: {
                nike: {
                  value: { domain: "nike.com" }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Cached or fresh PostgreSQL result returned"
          },
          "202": {
            description: "Analysis queued",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/QueuedAnalysisResponse" }
              }
            }
          },
          "400": { $ref: "#/components/responses/ValidationError" },
          "429": { $ref: "#/components/responses/RateLimited" }
        }
      }
    },
    "/v1/analysis/jobs/{jobId}": {
      get: {
        tags: ["Analysis"],
        summary: "Poll analysis job status",
        parameters: [{ $ref: "#/components/parameters/JobId" }],
        responses: {
          "200": {
            description: "Terminal job status returned"
          },
          "202": {
            description: "Job is queued or processing"
          },
          "400": { $ref: "#/components/responses/ValidationError" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/v1/domains/{domainId}/providers/{llmName}/scores": {
      get: {
        tags: ["Provider Scores"],
        summary: "Get latest scores for one provider",
        parameters: [{ $ref: "#/components/parameters/DomainId" }, { $ref: "#/components/parameters/LlmName" }],
        responses: {
          "200": { description: "Latest provider scores returned" },
          "400": { $ref: "#/components/responses/ValidationError" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/v1/domains/{domainId}/providers/{llmName}/history": {
      get: {
        tags: ["Provider Scores"],
        summary: "Get historical provider snapshots",
        parameters: [{ $ref: "#/components/parameters/DomainId" }, { $ref: "#/components/parameters/LlmName" }],
        responses: {
          "200": { description: "Provider history returned" },
          "400": { $ref: "#/components/responses/ValidationError" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/v1/domains/{domainId}/provider-scores": {
      get: {
        tags: ["Provider Scores"],
        summary: "Compare latest provider scores",
        parameters: [{ $ref: "#/components/parameters/DomainId" }],
        responses: {
          "200": { description: "Provider comparison returned" },
          "400": { $ref: "#/components/responses/ValidationError" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/v1/domains/{domainId}/visibility-score": {
      get: {
        tags: ["Visibility Scores"],
        summary: "Get latest aggregate visibility score",
        parameters: [{ $ref: "#/components/parameters/DomainId" }],
        responses: {
          "200": { description: "Latest visibility score returned" },
          "400": { $ref: "#/components/responses/ValidationError" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/v1/domains/{domainId}/visibility-score/history": {
      get: {
        tags: ["Visibility Scores"],
        summary: "Get aggregate visibility score history",
        parameters: [{ $ref: "#/components/parameters/DomainId" }],
        responses: {
          "200": { description: "Visibility score history returned" },
          "400": { $ref: "#/components/responses/ValidationError" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    },
    "/v1/domains/{domainId}/visibility-score/trend": {
      get: {
        tags: ["Visibility Scores"],
        summary: "Get latest visibility score trend",
        parameters: [{ $ref: "#/components/parameters/DomainId" }],
        responses: {
          "200": { description: "Visibility score trend returned" },
          "400": { $ref: "#/components/responses/ValidationError" },
          "404": { $ref: "#/components/responses/NotFound" }
        }
      }
    }
  },
  components: {
    parameters: {
      DomainId: {
        name: "domainId",
        in: "path",
        required: true,
        schema: { type: "integer", minimum: 1 }
      },
      JobId: {
        name: "jobId",
        in: "path",
        required: true,
        schema: { type: "integer", minimum: 1 }
      },
      LlmName: {
        name: "llmName",
        in: "path",
        required: true,
        schema: { type: "string", enum: ["openai", "gemini", "claude"] }
      }
    },
    responses: {
      ValidationError: {
        description: "Validation error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      },
      NotFound: {
        description: "Resource not found",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" }
          }
        }
      },
      RateLimited: {
        description: "Rate limit exceeded"
      }
    },
    schemas: {
      HealthResponse: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", example: "ok" }
        }
      },
      AnalysisRequest: {
        type: "object",
        required: ["domain"],
        properties: {
          domain: { type: "string", example: "nike.com", maxLength: 253 }
        }
      },
      QueuedAnalysisResponse: {
        type: "object",
        required: ["status", "job_id", "domain_id", "message", "domain"],
        properties: {
          status: { type: "string", example: "queued" },
          job_id: { type: "integer", example: 1 },
          domain_id: { type: "integer", example: 1 },
          bullmq_job_id: { type: "string", example: "1" },
          message: { type: "string", example: "Analysis started" },
          domain: { type: "string", example: "nike.com" }
        }
      },
      ErrorResponse: {
        type: "object",
        required: ["status", "error"],
        properties: {
          status: { type: "string", example: "error" },
          error: { type: "string", example: "Invalid request body" },
          details: { type: "object" }
        }
      }
    }
  }
} as const;
