const ownershipSecurity = [
  { anonymousSession: [] },
  { bearerAuth: [], workspaceId: [] },
  { bearerAuth: [], workspaceId: [], anonymousSession: [] }
] as const;

const MAX_REPORT_EXECUTION_ITEMS = 5_000;
const MAX_REPORT_CONSOLIDATED_ITEMS = 50;

function publicErrorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ApiErrorResponse" }
      }
    }
  } as const;
}

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
          "Analyzes exactly the supplied terminal hierarchy path; it never expands the selected node into children. Anonymous requests may target at most brand. Provider/model selection is immutable and owner-scoped idempotency is preserved.",
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
            description: "Pre-analysis request accepted or idempotently replayed",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CreateAnalysisResponse"
                }
              }
            }
          },
          "400": publicErrorResponse("Invalid input"),
          "401": publicErrorResponse("Missing or invalid session"),
          "403": publicErrorResponse("Workspace or claim access denied"),
          "404": publicErrorResponse("Selected hierarchy record not found"),
          "409": publicErrorResponse(
            "Idempotency key already used for a different normalized request"
          ),
          "500": publicErrorResponse("Unexpected internal error")
        }
      }
    },
    "/v1/analysis/hierarchy/children": {
      post: {
        tags: ["Analysis"],
        summary: "Resolve immediate children of one selected hierarchy path",
        description:
          "Queries authoritative PostgreSQL first. A hit returns all persisted immediate children synchronously with no outbox, RabbitMQ, provider, budget reservation, or token usage; selectionLimit separately reports the actor's 3/5 processing breadth. A miss accepts one asynchronous discovery stage on the existing discovery/provider queues. Anonymous actors may continue only domain-to-category and category-to-brand.",
        security: ownershipSecurity,
        parameters: [{
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 255 }
        }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/HierarchyNavigationRequest" } } }
        },
        responses: {
          "200": { description: "Persisted immediate children", content: { "application/json": { schema: { $ref: "#/components/schemas/HierarchyNavigationResponse" } } } },
          "202": { description: "One-stage discovery accepted or replayed", content: { "application/json": { schema: { $ref: "#/components/schemas/HierarchyNavigationResponse" } } } },
          "400": publicErrorResponse("Invalid or terminal parent path"),
          "401": publicErrorResponse("Missing or invalid session"),
          "403": publicErrorResponse("Hierarchy access or workspace mutation denied"),
          "404": publicErrorResponse("Selected hierarchy record not found"),
          "409": publicErrorResponse("Idempotency key reused for different navigation intent")
        }
      }
    },
    "/v1/analysis/preview": {
      post: {
        tags: ["Analysis"],
        summary: "Preview canonical analysis fan-out and estimated cost",
        description:
          "Returns a write-free estimate for exactly one supplied target path, its applicable prompts, and provider/model set. Child breadth is not multiplied into analysis estimates.",
        security: ownershipSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateAnalysisRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "Resolved planning estimate",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AnalysisPreviewResponse"
                }
              }
            }
          },
          "400": publicErrorResponse("Invalid input"),
          "401": publicErrorResponse("Missing or invalid session"),
          "403": publicErrorResponse("Workspace or claim access denied"),
          "500": publicErrorResponse("Unexpected internal error")
        }
      }
    },
    "/v1/analysis/requests/{preAnalysisRequestId}": {
      get: {
        tags: ["Analysis"],
        summary: "Read an owned pre-analysis request status",
        security: ownershipSecurity,
        parameters: [{ name: "preAnalysisRequestId", in: "path", required: true, schema: { $ref: "#/components/schemas/DatabaseId" } }],
        responses: {
          "200": { description: "Discovery and downstream analysis linkage status", content: { "application/json": { schema: { type: "object" } } } },
          "401": publicErrorResponse("Missing or invalid session"),
          "404": publicErrorResponse("Pre-analysis request not found for this owner")
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
          "401": publicErrorResponse("Missing or invalid session"),
          "403": publicErrorResponse("Workspace or claim access denied"),
          "404": publicErrorResponse("Run not found for this owner"),
          "500": publicErrorResponse("Unexpected internal error")
        }
      }
    },
    "/v1/analysis/runs/{analysisRunId}/report": {
      get: {
        tags: ["Analysis"],
        summary: "Read the latest owned report revision",
        description:
          "Returns the latest immutable multi-provider-geo-report-v3 revision. Revisions may be partial, budget-paused, completed, completed with gaps, failed empty, cancelled, or completed empty. Coverage retains provider/model provenance; invalid, failed, and missing evidence are never scored as zero.",
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
          "401": publicErrorResponse("Missing or invalid session"),
          "403": publicErrorResponse("Workspace or claim access denied"),
          "404": publicErrorResponse(
            "Run is not owned by this actor or its report is not ready"
          ),
          "500": publicErrorResponse("Unexpected internal error")
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
          "401": publicErrorResponse("Missing or invalid session"),
          "404": publicErrorResponse("Run not found for this owner"),
          "409": publicErrorResponse(
            "Provider execution already began or run is terminal"
          ),
          "500": publicErrorResponse("Unexpected internal error")
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
            example: "example.com",
            description:
              "Public ASCII website hostname only. Protocols, paths, ports, credentials, IP addresses, internal names, and free-form text are rejected."
          },
          categoryId: { $ref: "#/components/schemas/DatabaseId" },
          brandId: { $ref: "#/components/schemas/DatabaseId" },
          productId: { $ref: "#/components/schemas/DatabaseId" },
          useContextId: { $ref: "#/components/schemas/DatabaseId" },
          categorySelection: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["mode"],
                properties: { mode: { type: "string", enum: ["all"] } }
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["mode", "categoryIds"],
                properties: {
                  mode: { type: "string", enum: ["selected"] },
                  categoryIds: {
                    type: "array",
                    minItems: 1,
                    maxItems: 50,
                    uniqueItems: true,
                    items: { $ref: "#/components/schemas/DatabaseId" }
                  }
                }
              }
            ]
          },
          promptDepth: {
            type: "string",
            enum: ["weak", "medium", "high"],
            description:
              "Anonymous requests are fixed to weak. Logged-in and claimed requests must supply a depth."
          },
          providerModels: {
            type: "array",
            minItems: 1,
            maxItems: MAX_ANALYSIS_PROVIDER_MODELS,
            description:
              "Optional for logged-in requests. The set is validated, deduplicated, stably sorted, included in idempotency identity, and frozen on the run. Logged-in requests default to mock/mock-standard; anonymous requests always use mock/mock-fast and cannot supply this field.",
            items: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["provider", "model"],
                  properties: {
                    provider: {
                      type: "string",
                      enum: [...new Set(PROVIDER_MODEL_REGISTRY.map((profile) => profile.provider))]
                    },
                    model: {
                      type: "string",
                      enum: PROVIDER_MODEL_REGISTRY.map((profile) => profile.model)
                    }
                  }
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["provider", "selection"],
                  properties: {
                    provider: {
                      type: "string",
                      enum: [...new Set(PROVIDER_MODEL_REGISTRY.map((profile) => profile.provider))]
                    },
                    selection: { type: "string", enum: ["all"] }
                  }
                }
              ]
            }
          }
        }
      },
      CreateAnalysisResponse: {
        type: "object",
        required: [
          "preAnalysisRequestId",
          "analysisRunId",
          "status",
          "idempotentReplay",
          "createdAt"
        ],
        properties: {
          preAnalysisRequestId: { $ref: "#/components/schemas/DatabaseId" },
          analysisRunId: { oneOf: [{ $ref: "#/components/schemas/DatabaseId" }, { type: "null" }] },
          status: { type: "string", enum: ["accepted", "checking_hierarchy", "discovering", "planning", "analysis_created", "completed_without_analysis", "failed", "paused_budget", "cancelled"] },
          idempotentReplay: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" }
        }
      },
      HierarchyNavigationRequest: {
        type: "object",
        additionalProperties: false,
        required: ["domain"],
        properties: {
          domain: { type: "string" },
          categoryId: { $ref: "#/components/schemas/DatabaseId" },
          brandId: { $ref: "#/components/schemas/DatabaseId" },
          productId: { $ref: "#/components/schemas/DatabaseId" }
        }
      },
      HierarchyNavigationResponse: {
        type: "object",
        required: ["source", "requestedStage", "status", "preAnalysisRequestId", "children", "selectionLimit"],
        properties: {
          source: { type: "string", enum: ["database", "discovery"] },
          requestedStage: { type: "string", enum: ["category", "brand", "product", "use_context"] },
          status: { type: "string", enum: ["pending", "completed", "completed_empty", "partial", "paused_budget", "failed"] },
          preAnalysisRequestId: { allOf: [{ $ref: "#/components/schemas/DatabaseId" }], nullable: true },
          selectionLimit: { type: "integer", enum: [3, 5] },
          idempotentReplay: { type: "boolean" },
          children: {
            type: "array",
            items: {
              type: "object",
              required: ["entityType", "entityId", "name", "path", "canAnalyze", "canContinue"],
              properties: {
                entityType: { type: "string", enum: ["category", "brand", "product", "use_context"] },
                entityId: { $ref: "#/components/schemas/DatabaseId" },
                name: { type: "string" },
                path: { type: "object" },
                canAnalyze: { type: "boolean", enum: [true] },
                canContinue: { type: "boolean" }
              }
            }
          }
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
            enum: ["multi-provider-geo-report-v3", "basic-v1"]
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
          reportVersion: {
            type: "string",
            enum: ["multi-provider-geo-report-v3"]
          },
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
          methodology: {
            type: "object",
            description:
              "Safe frozen analysis, hierarchy-discovery, prompt/model, scoring, report, and canonical-planning lineage."
          },
          executiveSummary: {
            type: "object",
            description:
              "Deterministic summary derived from validated report evidence; no report-writing provider call is used."
          },
          overallDimensions: { type: "object" },
          counts: {
            type: "object",
            description:
              "Exact expected-versus-materialized coverage derived from frozen analysis items, prompt policy, and provider/model selection.",
            properties: {
              expectedProviderJobs: { type: "integer", minimum: 0 },
              materializedProviderJobs: { type: "integer", minimum: 0 },
              validScored: { type: "integer", minimum: 0 },
              validDiagnostic: { type: "integer", minimum: 0 },
              invalid: { type: "integer", minimum: 0 },
              technicalFailure: { type: "integer", minimum: 0 },
              budgetPaused: { type: "integer", minimum: 0 },
              cancelled: { type: "integer", minimum: 0 },
              missingBeforeFanOut: { type: "integer", minimum: 0 },
              permanentScoringFailure: { type: "integer", minimum: 0 },
              pending: { type: "integer", minimum: 0 },
              materializationCoverage: {
                type: "number",
                minimum: 0,
                maximum: 1,
                nullable: true
              },
              terminalCoverage: {
                type: "number",
                minimum: 0,
                maximum: 1,
                nullable: true
              },
              usableEvidenceCoverage: {
                type: "number",
                minimum: 0,
                maximum: 1,
                nullable: true
              },
              scoreBearingCoverage: {
                type: "number",
                minimum: 0,
                maximum: 1,
                nullable: true
              }
            }
          },
          coverage: {
            type: "object",
            description:
              "Alias of counts retained for report-contract compatibility."
          },
          missingExpectedExecutions: {
            type: "object",
            description:
              "Bounded deterministic details for exact expected executions missing before provider fan-out.",
            properties: {
              totalMissingCount: { type: "integer", minimum: 0 },
              returnedMissingCount: { type: "integer", minimum: 0 },
              truncated: { type: "boolean" },
              executions: {
                type: "array",
                maxItems: 500,
                items: { type: "object" }
              }
            }
          },
          providerResults: {
            type: "array",
            maxItems: MAX_REPORT_EXECUTION_ITEMS,
            description:
              "Coverage metadata and backend scores by logical prompt and provider/model execution. Raw provider bodies are not exposed.",
            items: { type: "object" }
          },
          usage: {
            type: "object",
            description:
              "Aggregate input/output token counts and integer micro-cost; each provider execution is counted once."
          },
          usageAndCost: {
            type: "object",
            description:
              "Frozen bounded planning estimates beside actual telemetry, variance, missing telemetry, and provider/model, category, prompt-type, hierarchy-discovery, and normal-analysis breakdowns."
          },
          categoryBreakdown: {
            type: "array",
            maxItems: MAX_REPORT_EXECUTION_ITEMS,
            items: { type: "object" },
            description:
              "Every expected category/model path, authoritative model-path GEO scores, discovery provenance, disagreement, exact coverage, and prompt outcomes."
          },
          providerModelComparison: {
            type: "array",
            maxItems: MAX_ANALYSIS_PROVIDER_MODELS,
            items: { type: "object" },
            description:
              "Exact model comparison. averageGeoScore averages available 60/40 model-path GEO scores, never raw metrics."
          },
          promptOutcomes: {
            type: "array",
            maxItems: MAX_REPORT_EXECUTION_ITEMS,
            items: { type: "object" }
          },
          visibility: {
            type: "array",
            maxItems: MAX_REPORT_CONSOLIDATED_ITEMS,
            items: { type: "object" }
          },
          ranking: {
            type: "array",
            maxItems: MAX_REPORT_CONSOLIDATED_ITEMS,
            items: { type: "object" }
          },
          competitors: {
            type: "array",
            maxItems: MAX_REPORT_CONSOLIDATED_ITEMS,
            items: { type: "object" }
          },
          price: {
            type: "array",
            maxItems: MAX_REPORT_CONSOLIDATED_ITEMS,
            items: { type: "object" }
          },
          prosAndCons: {
            type: "array",
            maxItems: MAX_REPORT_CONSOLIDATED_ITEMS,
            items: { type: "object" }
          }
        }
      },
      AnalysisPreviewResponse: {
        type: "object",
        required: [
          "normalizedDomain",
          "frozenCategoryIds",
          "frozenRequestedCategoryCount",
          "hierarchyReady",
          "discoveryRequired",
          "estimatedSelectedPathCount",
          "applicablePromptCountEstimate",
          "resolvedProviderModels",
          "normalProviderJobCountEstimate",
          "totalProviderJobCountEstimate",
          "tokenEstimate",
          "costEstimate",
          "safetyLimits",
          "canonicalRequestHash"
        ],
        properties: {
          normalizedDomain: { type: "string" },
          categorySelectionMode: {
            type: "string",
            enum: ["all", "selected"]
          },
          frozenCategoryIds: {
            type: "array",
            maxItems: 50,
            items: { $ref: "#/components/schemas/DatabaseId" }
          },
          frozenRequestedCategoryCount: { type: "integer", minimum: 0 },
          hierarchyReady: { type: "boolean" },
          discoveryRequired: { type: "boolean" },
          estimatedSelectedPathCount: {
            $ref: "#/components/schemas/EstimateRange"
          },
          applicablePromptCountEstimate: {
            $ref: "#/components/schemas/EstimateRange"
          },
          applicablePromptTypes: {
            type: "array",
            maxItems: 5,
            items: {
              type: "string",
              enum: [
                "visibility",
                "ranking",
                "competitor",
                "price_range",
                "pros_cons"
              ]
            }
          },
          resolvedModelCount: { type: "integer", minimum: 1 },
          resolvedProviderModels: {
            type: "array",
            maxItems: MAX_ANALYSIS_PROVIDER_MODELS,
            items: { type: "object" }
          },
          normalProviderJobCountEstimate: {
            $ref: "#/components/schemas/EstimateRange"
          },
          totalProviderJobCountEstimate: {
            $ref: "#/components/schemas/EstimateRange"
          },
          tokenEstimate: { type: "object" },
          costEstimate: { type: "object" },
          normalAnalysisEstimate: { type: "object" },
          byProviderModel: {
            type: "array",
            maxItems: MAX_ANALYSIS_PROVIDER_MODELS,
            items: { type: "object" }
          },
          safetyLimits: { type: "object" },
          canonicalPlannerVersion: { type: "string" },
          canonicalRequestHash: {
            type: "string",
            pattern: "^[0-9a-f]{64}$"
          },
          estimateNotice: { type: "string" }
        }
      },
      EstimateRange: {
        type: "object",
        required: ["minimum", "maximum"],
        properties: {
          minimum: { type: "integer", minimum: 0 },
          maximum: { type: "integer", minimum: 0 }
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
      },
      ApiErrorResponse: {
        type: "object",
        additionalProperties: false,
        required: ["status", "code", "error"],
        properties: {
          status: { type: "string", enum: ["error"] },
          code: {
            type: "string",
            enum: [
              "UNAUTHENTICATED",
              "FORBIDDEN",
              "NOT_FOUND",
              "CONFLICT",
              "VALIDATION_ERROR",
              "EXPIRED_SESSION",
              "REVOKED_SESSION",
              "DISABLED_USER",
              "INTERNAL_ERROR"
            ]
          },
          error: {
            type: "string",
            description:
              "Safe public message. Internal exceptions and provider/database diagnostics are never returned."
          },
          details: {
            type: "object",
            description:
              "Optional bounded validation/category details; never raw provider, SQL, stack, credential, session, or broker data."
          }
        }
      }
    }
  }
} as const;
import {
  MAX_ANALYSIS_PROVIDER_MODELS,
  PROVIDER_MODEL_REGISTRY
} from "../../modules/providers/registry/provider-model.registry.js";
