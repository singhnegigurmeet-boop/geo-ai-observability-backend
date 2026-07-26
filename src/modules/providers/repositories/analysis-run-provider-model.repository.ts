import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  AnalysisRunProviderModelRow,
  ProviderName
} from "../../../common/types/database.types.js";
import type {
  ProviderModelPair,
  ProviderModelSelection
} from "../policies/provider-model.policy.js";
import { providerModelProfile } from "../registry/provider-model.registry.js";

/**
 * Owns persistence for the immutable provider/model set frozen on a run.
 * Both manual and scheduled run creation use this repository, and execution
 * reads the exact same ordered representation.
 */
export class AnalysisRunProviderModelRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async createOrReuse(
    analysisRunId: string,
    providerModels: readonly (ProviderModelSelection | ProviderModelPair)[]
  ) {
    for (const [ordinal, pair] of providerModels.entries()) {
      const modelProfileVersion =
        "modelProfileVersion" in pair
          ? pair.modelProfileVersion
          : providerModelProfile(pair.provider, pair.model)?.modelProfileVersion;
      if (!modelProfileVersion) {
        throw new Error(
          `Cannot freeze unknown provider model ${pair.provider}/${pair.model}`
        );
      }
      await this.database.query(
        `
          INSERT INTO analysis_run_provider_models (
            analysis_run_id, provider, model, model_profile_version, ordinal
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (analysis_run_id, provider, model) DO NOTHING
        `,
        [
          analysisRunId,
          pair.provider,
          pair.model,
          modelProfileVersion,
          ordinal
        ]
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
