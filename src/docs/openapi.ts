export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "GEO V6 Production Core API",
    version: "0.1.0-phase3",
    description:
      "GEO V6 Production Core backend shell with database, messaging, and internal identity/workspace ownership foundations. Identity middleware is not globally mounted and no business APIs, consumers, workers, or providers are exposed."
  },
  servers: [
    {
      url: "http://127.0.0.1:4000",
      description: "Local development"
    }
  ],
  tags: [{ name: "Health" }],
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
    }
  },
  components: {
    schemas: {
      HealthResponse: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", example: "ok" }
        }
      }
    }
  }
} as const;
