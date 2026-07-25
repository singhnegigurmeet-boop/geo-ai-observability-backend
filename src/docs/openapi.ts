const ownershipSecurity = [
  { anonymousSession: [] },
  { bearerAuth: [], workspaceId: [] },
  { bearerAuth: [], workspaceId: [], anonymousSession: [] }
] as const;

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "GEO V6 Production Core API",
    version: "6.0.0",
    description:
      "GEO V6 Production Core. PostgreSQL is authoritative, RabbitMQ is transport, and provider outputs are evidence scored and reported by the backend."
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
    "/ready": {
      get: {
        tags: ["Health"],
        summary: "Check whether required infrastructure is ready",
        description:
          "Checks PostgreSQL, exact migration history, RabbitMQ, and all declared queues/DLQs. It never calls providers.",
        responses: {
          "200": {
            description: "All critical dependencies are ready",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReadinessResponse" }
              }
            }
          },
          "503": {
            description: "At least one critical dependency is unavailable or stale"
          }
        }
      }
    },
    "/v1/analysis": {
      post: {
        tags: ["Analysis"],
        summary: "Submit an analysis run",
        description:
          "Creates or replays a queued analysis run with an immutable normalized provider/model set. Anonymous requests use mock/mock-fast. User and claimed requests default to mock/mock-standard or may provide an explicit set. Provider-set order and duplicates do not change idempotency identity; a different normalized set conflicts under the same owner-scoped key.",
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
    },
    "/v1/analysis/runs/{analysisRunId}/report": {
      get: {
        tags: ["Analysis"],
        summary: "Read the latest owned report revision",
        description:
          "Returns the latest immutable multi-provider-v2 report revision. Revisions may be partial, budget-paused, completed, completed with gaps, failed empty, cancelled, or completed empty. Coverage retains provider/model provenance; invalid, failed, and missing evidence are never scored as zero.",
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
            description: "Latest owned partial or terminal report revision",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AnalysisReportResponse"
                }
              }
            }
          },
          "401": { description: "Missing or invalid session" },
          "403": { description: "Workspace or claim access denied" },
          "404": {
            description: "Run is not owned by this actor or its report is not ready"
          }
        }
      }
    },
    "/v1/analysis/runs/{analysisRunId}/cancel": {
      post: {
        tags: ["Analysis"],
        summary: "Cancel an owned analysis before provider execution begins",
        description:
          "Cancellation is idempotent while the run remains cancellable. It conflicts once any provider execution has started or another terminal outcome has won. Delayed queue deliveries for cancelled work are acknowledged as no-ops.",
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
          "200": { description: "Analysis cancelled or already cancelled" },
          "401": { description: "Missing or invalid session" },
          "404": { description: "Run not found for this owner" },
          "409": { description: "Provider execution already began or run is terminal" }
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
      ReadinessResponse: {
        type: "object",
        required: ["status", "checks"],
        properties: {
          status: { type: "string", enum: ["ready", "not_ready"] },
          checks: {
            type: "object",
            additionalProperties: false,
            required: ["database", "migrations", "rabbitmq", "queues"],
            properties: {
              database: { $ref: "#/components/schemas/ReadinessCheck" },
              migrations: { $ref: "#/components/schemas/ReadinessCheck" },
              rabbitmq: { $ref: "#/components/schemas/ReadinessCheck" },
              queues: { $ref: "#/components/schemas/ReadinessCheck" }
            }
          }
        }
      },
      ReadinessCheck: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["ok", "failed"] }
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
          useContextId: { $ref: "#/components/schemas/DatabaseId" },
          preferredProvider: {
            type: "string",
            enum: ["mock", "openai", "gemini", "claude"],
            deprecated: true,
            description:
              "Deprecated single-pair compatibility field for logged-in requests. Use providerModels. Must be paired consistently with preferredModel and cannot be mixed with providerModels. Real providers require ENABLE_REAL_PROVIDERS=true."
          },
          preferredModel: {
            type: "string",
            enum: [
              "mock-fast",
              "mock-standard",
              "mock-quality",
              "gpt-4o-mini",
              "gemini-1.5-flash",
              "claude-3-5-sonnet"
            ],
            deprecated: true,
            description:
              "Deprecated single-pair compatibility field for logged-in requests. Use providerModels. Defaults to mock-standard when no provider selection is supplied."
          },
          providerModels: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            description:
              "Logged-in requests only. Normalized, deduplicated, and sorted; cannot be combined with legacy preferred fields.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["provider", "model"],
              properties: {
                provider: {
                  type: "string",
                  enum: ["mock", "openai", "gemini", "claude"]
                },
                model: {
                  type: "string",
                  enum: [
                    "mock-fast",
                    "mock-standard",
                    "mock-quality",
                    "gpt-4o-mini",
                    "gemini-1.5-flash",
                    "claude-3-5-sonnet"
                  ]
                }
              }
            }
          }
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
      AnalysisReportResponse: {
        type: "object",
        required: [
          "analysisRunId",
          "reportId",
          "reportVersion",
          "revision",
          "status",
          "report",
          "renderedText",
          "generatedAt"
        ],
        properties: {
          analysisRunId: { $ref: "#/components/schemas/DatabaseId" },
          reportId: { $ref: "#/components/schemas/DatabaseId" },
          reportVersion: {
            type: "string",
            enum: ["multi-provider-v2", "basic-v1"]
          },
          revision: { type: "integer", minimum: 1 },
          status: {
            type: "string",
            enum: ["partial", "completed", "failed"]
          },
          report: {
            allOf: [{ $ref: "#/components/schemas/MultiProviderReport" }],
            description:
              "Latest immutable report snapshot with provider coverage, prompt-level means, gaps, and usage."
          },
          renderedText: { type: "string", nullable: true },
          generatedAt: { type: "string", format: "date-time" }
        }
      },
      MultiProviderReport: {
        type: "object",
        required: [
          "reportVersion",
          "lifecycleState",
          "final",
          "resumePossible",
          "counts",
          "providerResults",
          "usage"
        ],
        properties: {
          reportVersion: { type: "string", enum: ["multi-provider-v2"] },
          lifecycleState: {
            type: "string",
            enum: [
              "partial",
              "budget_paused_partial",
              "completed",
              "completed_with_gaps",
              "failed_empty",
              "cancelled_partial",
              "cancelled_empty",
              "completed_empty"
            ]
          },
          final: { type: "boolean" },
          resumePossible: { type: "boolean", enum: [false] },
          overallScore: { type: "number", nullable: true },
          counts: {
            type: "object",
            description:
              "Separate counts for expected, nonterminal, scored, invalid, failed, budget-paused, and cancelled provider executions."
          },
          providerResults: {
            type: "array",
            description:
              "Coverage metadata and backend scores by logical prompt and provider/model execution. Raw provider bodies are not exposed.",
            items: { type: "object" }
          },
          usage: {
            type: "object",
            description:
              "Aggregate input/output token counts and integer micro-cost; each provider execution is counted once."
          }
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
