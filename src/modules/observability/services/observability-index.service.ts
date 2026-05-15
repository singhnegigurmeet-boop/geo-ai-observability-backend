import { Client } from "@elastic/elasticsearch";
import { PROVIDER_RESPONSE_INDEX, PROVIDERS } from "../../../config/constants.js";
import type { TraceDocument } from "../../../types/observability.types.js";

type ObservabilityIndexServiceDependencies = {
  elasticsearch: Client;
};

export class ObservabilityIndexService {
  private indexSetupPromise: Promise<void> | null = null;

  constructor(private readonly dependencies: ObservabilityIndexServiceDependencies) {}

  ensureObservabilityIndexes() {
    this.indexSetupPromise ??= this.createObservabilityIndexes().catch((error) => {
      this.indexSetupPromise = null;
      throw error;
    });
    return this.indexSetupPromise;
  }

  async indexProviderTrace(document: TraceDocument) {
    try {
      await this.ensureObservabilityIndexes();
      await this.indexTraceDocument(document);
    } catch (error) {
      this.logIndexingError("Failed to index provider trace document", error);
    }
  }

  async indexProviderTraces(documents: TraceDocument[]) {
    if (documents.length === 0) {
      return;
    }

    try {
      await this.ensureObservabilityIndexes();
    } catch (error) {
      this.logIndexingError("Failed to prepare Elasticsearch observability indexes", error);
      return;
    }

    const results = await Promise.allSettled(documents.map((document) => this.indexTraceDocument(document)));
    const failures = results.filter((result) => result.status === "rejected");

    if (failures.length > 0) {
      console.error(`Failed to index ${failures.length} provider trace document(s)`);
    }
  }

  private async indexTraceDocument(document: TraceDocument) {
    await this.dependencies.elasticsearch.index({
      index: PROVIDER_RESPONSE_INDEX[document.llm_name],
      document
    });
  }

  private async createObservabilityIndexes() {
    await Promise.all(
      PROVIDERS.map(async (provider) => {
        const index = PROVIDER_RESPONSE_INDEX[provider];
        const exists = await this.dependencies.elasticsearch.indices.exists({ index });

        if (exists) {
          return;
        }

        await this.dependencies.elasticsearch.indices.create({
          index,
          settings: {
            number_of_shards: 1,
            number_of_replicas: 0
          },
          mappings: {
            dynamic: "strict",
            properties: {
              provider_analysis_id: { type: "integer" },
              provider_snapshot_id: { type: "integer" },
              domain: { type: "keyword" },
              llm_name: { type: "keyword" },
              ranking_prompt_name: { type: "keyword" },
              ranking_prompt_text: { type: "text" },
              ranking_prompt_response: { type: "text" },
              observability_prompt_name: { type: "keyword" },
              observability_prompt_text: { type: "text" },
              observability_prompt_response: { type: "text" },
              scoring_prompt_name: { type: "keyword" },
              scoring_prompt_text: { type: "text" },
              scoring_prompt_response: { type: "text" },
              top_k: { type: "integer" },
              rank_position: { type: "integer" },
              mention_count: { type: "integer" },
              provider_score: { type: "float" },
              overall_geo_score: { type: "float" },
              status: { type: "keyword" },
              error_type: { type: "keyword" },
              error_message: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 512 } } },
              retry_count: { type: "integer" },
              timestamp: { type: "date" }
            }
          }
        });

        console.log(`Created Elasticsearch index: ${index}`);
      })
    );
  }

  private logIndexingError(message: string, error: unknown) {
    const detail = error instanceof Error ? error.message : error;
    console.error(message, detail);
  }
}
