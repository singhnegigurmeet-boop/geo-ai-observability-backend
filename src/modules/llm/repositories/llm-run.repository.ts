import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  AnalysisRunItemRow,
  AnalysisRunRow,
  EntityPathRow,
  LlmRunRow
} from "../../../common/types/database.types.js";

export class LlmRunRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findParentRun(analysisRunId: string) {
    const result = await this.database.query<AnalysisRunRow>(
      "SELECT * FROM analysis_runs WHERE analysis_run_id = $1",
      [analysisRunId]
    );
    return result.rows[0] ?? null;
  }

  async findForUpdate(llmRunId: string) {
    const result = await this.database.query<LlmRunRow>(
      "SELECT * FROM llm_runs WHERE llm_run_id = $1 FOR UPDATE",
      [llmRunId]
    );
    return result.rows[0] ?? null;
  }

  async findParentItem(analysisRunItemId: string) {
    const result = await this.database.query<AnalysisRunItemRow>(
      `
        SELECT *
        FROM analysis_run_items
        WHERE analysis_run_item_id = $1
      `,
      [analysisRunItemId]
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

  async markProcessing(llmRunId: string) {
    const result = await this.database.query<LlmRunRow>(
      `
        UPDATE llm_runs
        SET status = 'processing',
            started_at = COALESCE(started_at, now()),
            completed_at = NULL,
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE llm_run_id = $1 AND status = 'queued'
        RETURNING *
      `,
      [llmRunId]
    );
    return result.rows[0] ?? null;
  }
}
