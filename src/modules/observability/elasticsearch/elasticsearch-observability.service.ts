import { Client } from "@elastic/elasticsearch";
import {
  OBSERVABILITY_INDEX_DEFINITIONS,
  OBSERVABILITY_INDEXES
} from "./observability-index-definitions.js";
import type {
  NotificationDocument,
  ScheduledRunDocument,
  TraceDocument
} from "../../../types/observability.types.js";

type ElasticsearchObservabilityServiceDependencies = {
  elasticsearch: Client;
};

export class ElasticsearchObservabilityService {
  private setupPromise: Promise<void> | null = null;
  private setupAttempted = false;
  private setupSucceeded = false;

  constructor(private readonly dependencies: ElasticsearchObservabilityServiceDependencies) {}

  ensureObservabilityIndexes() {
    if (this.setupPromise) {
      return this.setupPromise;
    }

    this.setupAttempted = true;
    this.setupPromise = this.createObservabilityIndexes()
      .then(() => {
        this.setupSucceeded = true;
      })
      .catch((error) => {
        this.setupSucceeded = false;
        throw error;
      });

    return this.setupPromise;
  }

  async initialize() {
    try {
      await this.ensureObservabilityIndexes();
    } catch (error) {
      this.logIndexingError("Failed to prepare Elasticsearch observability indexes", error);
    }
  }

  async indexProviderTrace(document: TraceDocument) {
    await this.indexDocument(
      "provider trace",
      OBSERVABILITY_INDEXES.providerResponses[document.llm_name],
      document
    );
  }

  async indexProviderTraces(documents: TraceDocument[]) {
    if (documents.length === 0) {
      return;
    }

    await this.prepareForIndexing();

    if (!this.setupSucceeded) {
      return;
    }

    const results = await Promise.allSettled(
      documents.map((document) =>
        this.dependencies.elasticsearch.index({
          index: OBSERVABILITY_INDEXES.providerResponses[document.llm_name],
          document
        })
      )
    );
    const failures = results.filter((result) => result.status === "rejected");

    if (failures.length > 0) {
      console.error(`Failed to index ${failures.length} provider trace document(s)`);
    }
  }

  async indexScheduledRun(document: ScheduledRunDocument) {
    await this.indexDocument("scheduled run", OBSERVABILITY_INDEXES.scheduledRuns, document);
  }

  async indexNotification(document: NotificationDocument) {
    await this.indexDocument("notification", OBSERVABILITY_INDEXES.notifications, document);
  }

  private async indexDocument(label: string, index: string, document: object) {
    try {
      await this.prepareForIndexing();

      if (!this.setupSucceeded) {
        return;
      }

      await this.dependencies.elasticsearch.index({
        index,
        document
      });
    } catch (error) {
      this.logIndexingError(`Failed to index ${label} document`, error);
    }
  }

  private async prepareForIndexing() {
    if (this.setupSucceeded) {
      return;
    }

    if (!this.setupAttempted) {
      await this.initialize();
    }
  }

  private async createObservabilityIndexes() {
    await Promise.all(
      OBSERVABILITY_INDEX_DEFINITIONS.map(async ({ index, mappings }) => {
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
          mappings
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

export { ElasticsearchObservabilityService as ObservabilityIndexService };
