import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  AnalysisRunProviderModelRow,
  ProviderName
} from "../types/database.types.js";
import type { ProviderModelPair } from "./provider-model.policy.js";

/**
 * Owns persistence for the immutable provider/model set frozen on a run.
 * Both manual and scheduled run creation use this repository, and execution
 * reads the exact same ordered representation.
 */
export class AnalysisRunProviderModelRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async createOrReuse(
    analysisRunId: string,
    providerModels: readonly ProviderModelPair[]
  ) {
    for (const [ordinal, pair] of providerModels.entries()) {
      await this.database.query(
        `
          INSERT INTO analysis_run_provider_models (
            analysis_run_id, provider, model, ordinal
          )
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (analysis_run_id, provider, model) DO NOTHING
        `,
        [analysisRunId, pair.provider, pair.model, ordinal]
      );
    }
    return this.list(analysisRunId);
  }

  async list(analysisRunId: string) {
    const result = await this.database.query<AnalysisRunProviderModelRow>(
      `
        SELECT *
        FROM analysis_run_provider_models
        WHERE analysis_run_id = $1
        ORDER BY ordinal, provider, model
      `,
      [analysisRunId]
    );
    return result.rows;
  }

  async listPairs(analysisRunId: string): Promise<
    Array<{ provider: ProviderName; model: string }>
  > {
    return (await this.list(analysisRunId)).map(({ provider, model }) => ({
      provider,
      model
    }));
  }
}
