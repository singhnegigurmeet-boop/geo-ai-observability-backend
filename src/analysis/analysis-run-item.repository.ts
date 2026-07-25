import type { DatabaseExecutor } from "../db/database-executor.js";
import type { AnalysisRunItemRow } from "../types/database.types.js";

export class AnalysisRunItemRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async createOrReuse(input: {
    analysisRunId: string;
    entityPathId: string;
    ordinal: number;
  }) {
    const idempotencyKey =
      `analysis_run_item:${input.analysisRunId}:${input.entityPathId}`;
    const inserted = await this.database.query<AnalysisRunItemRow>(
      `
        INSERT INTO analysis_run_items (
          idempotency_key,
          analysis_run_id,
          entity_path_id,
          item_ordinal,
          status
        )
        VALUES ($1, $2, $3, $4, 'queued')
        ON CONFLICT (analysis_run_id, entity_path_id) DO NOTHING
        RETURNING *
      `,
      [
        idempotencyKey,
        input.analysisRunId,
        input.entityPathId,
        input.ordinal
      ]
    );
    if (inserted.rows[0]) {
      return inserted.rows[0];
    }

    const existing = await this.database.query<AnalysisRunItemRow>(
      `
        SELECT *
        FROM analysis_run_items
        WHERE analysis_run_id = $1
          AND entity_path_id = $2
          AND idempotency_key = $3
      `,
      [input.analysisRunId, input.entityPathId, idempotencyKey]
    );
    const row = existing.rows[0];
    if (!row || row.item_ordinal !== input.ordinal) {
      throw new Error("Existing analysis run item has an inconsistent ordinal");
    }
    return row;
  }

  async findForUpdate(analysisRunItemId: string) {
    const result = await this.database.query<AnalysisRunItemRow>(
      `
        SELECT *
        FROM analysis_run_items
        WHERE analysis_run_item_id = $1
        FOR UPDATE
      `,
      [analysisRunItemId]
    );
    return result.rows[0] ?? null;
  }

  async markProcessing(analysisRunItemId: string) {
    const result = await this.database.query<AnalysisRunItemRow>(
      `
        UPDATE analysis_run_items
        SET status = 'processing',
            started_at = COALESCE(started_at, now()),
            completed_at = NULL,
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE analysis_run_item_id = $1 AND status = 'queued'
        RETURNING *
      `,
      [analysisRunItemId]
    );
    return result.rows[0] ?? null;
  }
}
