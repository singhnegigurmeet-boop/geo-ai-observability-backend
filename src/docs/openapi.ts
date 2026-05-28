export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "GEO AI Observability Backend API",
    version: "0.1.0-v6-placeholder",
    description: "V6 hierarchy-aware GEO API placeholder. Analysis and discovery contracts are active, but execution is intentionally not implemented yet."
  },
  servers: [
    {
      url: "http://127.0.0.1:4000",
      description: "Local development"
    }
  ],
  tags: [{ name: "Health" }, { name: "Analysis" }, { name: "Discovery" }],
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
        summary: "Accept the V6 analysis contract",
        description: "Placeholder endpoint. It validates DB-controlled hierarchy IDs and returns 501 until V6 execution is rebuilt.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AnalysisRequest" }
            }
          }
        },
        responses: {
          "501": { description: "V6 analysis execution is not implemented yet" },
          "400": { $ref: "#/components/responses/ValidationError" }
        }
      }
    },
    "/v1/analysis/runs/{analysisRunId}": {
      get: {
        tags: ["Analysis"],
        summary: "V6 analysis status placeholder",
        parameters: [{ $ref: "#/components/parameters/AnalysisRunId" }],
        responses: {
          "501": { description: "V6 run status is not implemented yet" },
          "400": { $ref: "#/components/responses/ValidationError" }
        }
      }
    },
    "/v1/analysis/runs/{analysisRunId}/diffs": {
      get: {
        tags: ["Analysis"],
        summary: "V6 analysis diffs placeholder",
        parameters: [{ $ref: "#/components/parameters/AnalysisRunId" }],
        responses: {
          "501": { description: "V6 diffs are not implemented yet" },
          "400": { $ref: "#/components/responses/ValidationError" }
        }
      }
    },
    "/v1/discovery": {
      post: {
        tags: ["Discovery"],
        summary: "Accept the V6 discovery contract",
        description: "Placeholder endpoint. Discovery can carry missing free-text brand/product names, but does not run analysis.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DiscoveryRequest" }
            }
          }
        },
        responses: {
          "501": { description: "V6 discovery persistence is not implemented yet" },
          "400": { $ref: "#/components/responses/ValidationError" }
        }
      }
    }
  },
  components: {
    parameters: {
      AnalysisRunId: {
        name: "analysisRunId",
        in: "path",
        required: true,
        schema: { type: "integer", minimum: 1 }
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
          domain: { type: "string", example: "nike.com", maxLength: 253 },
          categories: {
            type: "array",
            maxItems: 5,
            items: { $ref: "#/components/schemas/AnalysisCategorySelection" }
          }
        }
      },
      AnalysisCategorySelection: {
        type: "object",
        required: ["categoryId"],
        properties: {
          categoryId: { type: "integer", minimum: 1 },
          brands: {
            type: "array",
            items: { $ref: "#/components/schemas/AnalysisBrandSelection" }
          }
        }
      },
      AnalysisBrandSelection: {
        type: "object",
        required: ["brandId"],
        properties: {
          brandId: { type: "integer", minimum: 1 },
          products: {
            type: "array",
            items: { $ref: "#/components/schemas/AnalysisProductSelection" }
          }
        }
      },
      AnalysisProductSelection: {
        type: "object",
        required: ["productId"],
        properties: {
          productId: { type: "integer", minimum: 1 },
          useContextIds: {
            type: "array",
            maxItems: 4,
            items: { type: "integer", minimum: 1 }
          }
        }
      },
      DiscoveryRequest: {
        oneOf: [
          { $ref: "#/components/schemas/DomainDiscoveryRequest" },
          { $ref: "#/components/schemas/BrandDiscoveryRequest" },
          { $ref: "#/components/schemas/ProductDiscoveryRequest" }
        ],
        discriminator: { propertyName: "kind" }
      },
      DomainDiscoveryRequest: {
        type: "object",
        required: ["kind", "domain"],
        properties: {
          kind: { type: "string", enum: ["domain"] },
          domain: { type: "string", example: "nike.com" },
          categoryId: { type: "integer", minimum: 1 },
          notes: { type: "string", maxLength: 2000 }
        }
      },
      BrandDiscoveryRequest: {
        type: "object",
        required: ["kind", "domain", "brandName"],
        properties: {
          kind: { type: "string", enum: ["brand"] },
          domain: { type: "string", example: "nike.com" },
          brandName: { type: "string", example: "Nike" },
          categoryId: { type: "integer", minimum: 1 },
          notes: { type: "string", maxLength: 2000 }
        }
      },
      ProductDiscoveryRequest: {
        type: "object",
        required: ["kind", "domain", "productName"],
        properties: {
          kind: { type: "string", enum: ["product"] },
          domain: { type: "string", example: "nike.com" },
          brandId: { type: "integer", minimum: 1 },
          productName: { type: "string", example: "Pegasus 41" },
          categoryId: { type: "integer", minimum: 1 },
          notes: { type: "string", maxLength: 2000 }
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

