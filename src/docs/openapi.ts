const ownershipSecurity = [
  { anonymousSession: [] },
  { bearerAuth: [], workspaceId: [] },
  { bearerAuth: [], workspaceId: [], anonymousSession: [] }
] as const;

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "GEO V6 Production Core API",
    version: "0.1.0-phase4",
    description:
      "GEO V6 Production Core Phase 4 API. Analysis submission creates a queued analysis run and transactional outbox event only; expansion, providers, scoring, and reports remain unimplemented."
  },
  servers: [
    {
      url: "http://127.0.0.1:4000",
      description: "Local development"
    }
  ],
  tags: [{ name: "Health" }, { name: "Analysis" }],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Check API process health",
        responses: {
          "200": {
            description: "API process is healthy",
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
        summary: "Submit an analysis run",
        description:
          "Creates or replays a queued analysis run and atomically records its analysis_run.created outbox event.",
        security: ownershipSecurity,
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 255 }
          }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateAnalysisRequest" }
            }
          }
        },
        responses: {
          "202": {
            description: "Analysis run accepted or idempotently replayed",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CreateAnalysisResponse"
                }
              }
            }
          },
          "400": { description: "Invalid input" },
          "401": { description: "Missing or invalid session" },
          "403": { description: "Workspace or claim access denied" },
          "404": { description: "Selected hierarchy record not found" },
          "409": {
            description:
              "Idempotency key already used for a different normalized request"
          }
        }
      }
    },
    "/v1/analysis/runs/{analysisRunId}": {
      get: {
        tags: ["Analysis"],
        summary: "Read an owned analysis run status",
        security: ownershipSecurity,
        parameters: [
          {
            name: "analysisRunId",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[1-9][0-9]*$" }
          }
        ],
        responses: {
          "200": {
            description: "Owned analysis run status and starting path",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AnalysisRunStatusResponse"
                }
              }
            }
          },
          "401": { description: "Missing or invalid session" },
          "403": { description: "Workspace or claim access denied" },
          "404": { description: "Run not found for this owner" }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "opaque-session-token"
      },
      workspaceId: {
        type: "apiKey",
        in: "header",
        name: "X-Workspace-Id"
      },
      anonymousSession: {
        type: "apiKey",
        in: "header",
        name: "X-Anonymous-Session-Token"
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
      CreateAnalysisRequest: {
        type: "object",
        additionalProperties: false,
        required: ["domain"],
        properties: {
          domain: {
            type: "string",
            example: "https://www.example.com/catalog?source=campaign",
            description:
              "Bare hostname or HTTP(S) URL-like value. Only the normalized public ASCII hostname is retained."
          },
          categoryId: { $ref: "#/components/schemas/DatabaseId" },
          brandId: { $ref: "#/components/schemas/DatabaseId" },
          productId: { $ref: "#/components/schemas/DatabaseId" },
          useContextId: { $ref: "#/components/schemas/DatabaseId" }
        }
      },
      CreateAnalysisResponse: {
        type: "object",
        required: [
          "analysisRunId",
          "startingEntityPathId",
          "status",
          "idempotentReplay",
          "createdAt"
        ],
        properties: {
          analysisRunId: { $ref: "#/components/schemas/DatabaseId" },
          startingEntityPathId: {
            $ref: "#/components/schemas/DatabaseId"
          },
          status: { type: "string", enum: ["queued"] },
          idempotentReplay: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" }
        }
      },
      AnalysisRunStatusResponse: {
        type: "object",
        required: [
          "analysisRunId",
          "status",
          "source",
          "startingPath",
          "errorCode",
          "errorMessage",
          "startedAt",
          "completedAt",
          "createdAt",
          "updatedAt"
        ],
        properties: {
          analysisRunId: { $ref: "#/components/schemas/DatabaseId" },
          status: {
            type: "string",
            enum: [
              "queued",
              "processing",
              "paused_budget",
              "completed",
              "partial_success",
              "failed",
              "cancelled"
            ]
          },
          source: { type: "string", enum: ["manual", "scheduled"] },
          startingPath: {
            $ref: "#/components/schemas/StartingEntityPath"
          },
          errorCode: { type: "string", nullable: true },
          errorMessage: { type: "string", nullable: true },
          startedAt: { type: "string", format: "date-time", nullable: true },
          completedAt: {
            type: "string",
            format: "date-time",
            nullable: true
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" }
        }
      },
      StartingEntityPath: {
        type: "object",
        required: [
          "entityPathId",
          "pathType",
          "domainId",
          "normalizedDomain",
          "categoryId",
          "brandId",
          "productId",
          "useContextId"
        ],
        properties: {
          entityPathId: { $ref: "#/components/schemas/DatabaseId" },
          pathType: {
            type: "string",
            enum: ["domain", "category", "brand", "product", "use_context"]
          },
          domainId: { $ref: "#/components/schemas/DatabaseId" },
          normalizedDomain: { type: "string" },
          categoryId: {
            allOf: [{ $ref: "#/components/schemas/DatabaseId" }],
            nullable: true
          },
          brandId: {
            allOf: [{ $ref: "#/components/schemas/DatabaseId" }],
            nullable: true
          },
          productId: {
            allOf: [{ $ref: "#/components/schemas/DatabaseId" }],
            nullable: true
          },
          useContextId: {
            allOf: [{ $ref: "#/components/schemas/DatabaseId" }],
            nullable: true
          }
        }
      },
      DatabaseId: {
        type: "string",
        pattern: "^[1-9][0-9]*$"
      }
    }
  }
} as const;
