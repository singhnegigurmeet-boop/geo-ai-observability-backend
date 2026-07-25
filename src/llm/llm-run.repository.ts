import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  AnalysisRunRow,
  EntityPathRow,
  LlmRunRow
} from "../types/database.types.js";

export class LlmRunRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findParentRun(analysisRunId: string) {
    const result = await this.database.query<AnalysisRunRow>(
      "SELECT * FROM analysis_runs WHERE analysis_run_id = $1",
      [analysisRunId]
    );
    return result.rows[0] ?? null;
  }

  async findActiveEntityPath(entityPathId: string) {
    const result = await this.database.query<EntityPathRow>(
      "SELECT * FROM entity_paths WHERE entity_path_id = $1 AND is_active",
      [entityPathId]
    );
    return result.rows[0] ?? null;
  }

  async createOrReuseForItem(analysisRunItemId: string) {
    const idempotencyKey = `llm_run:${analysisRunItemId}`;
    const inserted = await this.database.query<LlmRunRow>(
      `
        INSERT INTO llm_runs (
          idempotency_key,
          analysis_run_item_id,
          run_key,
          status
        )
        VALUES ($1, $2, 'primary', 'queued')
        ON CONFLICT (analysis_run_item_id, run_key) DO NOTHING
        RETURNING *
      `,
      [idempotencyKey, analysisRunItemId]
    );
    if (inserted.rows[0]) {
      return inserted.rows[0];
    }

    const existing = await this.database.query<LlmRunRow>(
      `
        SELECT *
        FROM llm_runs
        WHERE analysis_run_item_id = $1
          AND run_key = 'primary'
          AND idempotency_key = $2
      `,
      [analysisRunItemId, idempotencyKey]
    );
    if (!existing.rows[0]) {
      throw new Error("Existing LLM run violates its stable identity");
    }
    return existing.rows[0];
  }
}
