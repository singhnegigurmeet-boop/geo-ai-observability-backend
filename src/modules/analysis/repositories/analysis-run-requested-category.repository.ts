import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  AnalysisRunRequestedCategoryRow,
  CategoryRow
} from "../../../common/types/database.types.js";

export const MAX_TAXONOMY_CATEGORIES = 50;

export class AnalysisRunRequestedCategoryRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async resolveActive(
    selection:
      | { mode: "all" }
      | { mode: "selected"; categoryIds: readonly string[] }
  ): Promise<CategoryRow[]> {
    const result =
      selection.mode === "all"
        ? await this.database.query<CategoryRow>(
            `
              SELECT *
              FROM categories
              WHERE is_active
              ORDER BY normalized_name, category_id
              LIMIT $1
            `,
            [MAX_TAXONOMY_CATEGORIES + 1]
          )
        : await this.database.query<CategoryRow>(
            `
              SELECT *
              FROM categories
              WHERE is_active AND category_id = ANY($1::bigint[])
            `,
            [selection.categoryIds]
          );
    if (result.rows.length > MAX_TAXONOMY_CATEGORIES) {
      throw new Error(
        `Active category taxonomy exceeds the supported maximum of ${MAX_TAXONOMY_CATEGORIES}`
      );
    }
    if (selection.mode === "all") return result.rows;

    const byId = new Map(result.rows.map((row) => [row.category_id, row]));
    return selection.categoryIds.map((categoryId) => {
      const category = byId.get(categoryId);
      if (!category) {
        throw new InactiveRequestedCategoryError(categoryId);
      }
      return category;
    });
  }

  async createOrReuse(analysisRunId: string, categoryIds: readonly string[]) {
    for (const [ordinal, categoryId] of categoryIds.entries()) {
      await this.database.query(
        `
          INSERT INTO analysis_run_requested_categories (
            analysis_run_id, category_id, ordinal
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (analysis_run_id, category_id) DO NOTHING
        `,
        [analysisRunId, categoryId, ordinal]
      );
    }
    return this.listIds(analysisRunId);
  }

  async listIds(analysisRunId: string) {
    const result =
      await this.database.query<AnalysisRunRequestedCategoryRow>(
        `
          SELECT *
          FROM analysis_run_requested_categories
          WHERE analysis_run_id = $1
          ORDER BY ordinal
        `,
        [analysisRunId]
      );
    return result.rows.map((row) => row.category_id);
  }
}

export class InactiveRequestedCategoryError extends Error {
  constructor(readonly categoryId: string) {
    super(`Category ${categoryId} does not exist or is inactive`);
    this.name = "InactiveRequestedCategoryError";
  }
}
