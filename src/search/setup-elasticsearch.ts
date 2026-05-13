import { elasticsearch } from "../lib/elasticsearch.js";
import { ObservabilityIndexService } from "../services/observability-index.service.js";

const observabilityIndexService = new ObservabilityIndexService({ elasticsearch });

observabilityIndexService
  .ensureObservabilityIndexes()
  .then(async () => {
    console.log("Elasticsearch observability indexes are ready.");
    await elasticsearch.close();
  })
  .catch(async (error) => {
    console.error("Failed to create Elasticsearch observability indexes.", error);
    await elasticsearch.close();
    process.exit(1);
  });
