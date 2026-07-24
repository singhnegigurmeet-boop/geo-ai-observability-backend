import type { DatabaseExecutor } from "../db/database-executor.js";
import { ApplicationError } from "../errors/application-error.js";
import type {
  EntityPathRow,
  EntityPathType
} from "../types/database.types.js";

export type EntityPathSelection = {
  domainId: string;
  categoryId: string | null;
  brandId: string | null;
  productId: string | null;
  useContextId: string | null;
  pathType: EntityPathType;
};

export class EntityPathRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findExact(input: EntityPathSelection) {
    const result = await this.database.query<EntityPathRow>(
      `
        SELECT *
        FROM entity_paths
        WHERE domain_id = $1
          AND category_id IS NOT DISTINCT FROM $2
          AND brand_id IS NOT DISTINCT FROM $3
          AND product_id IS NOT DISTINCT FROM $4
          AND use_context_id IS NOT DISTINCT FROM $5
          AND is_active
      `,
      [
        input.domainId,
        input.categoryId,
        input.brandId,
        input.productId,
        input.useContextId
      ]
    );
    return result.rows[0] ?? null;
  }

  async findOrCreate(input: EntityPathSelection) {
    const inserted = await this.database.query<EntityPathRow>(
      `
        INSERT INTO entity_paths (
          domain_id,
          category_id,
          brand_id,
          product_id,
          use_context_id,
          path_type
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT ON CONSTRAINT entity_paths_hierarchy_unique DO NOTHING
        RETURNING *
      `,
      [
        input.domainId,
        input.categoryId,
        input.brandId,
        input.productId,
        input.useContextId,
        input.pathType
      ]
    );
    if (inserted.rows[0]) {
      return inserted.rows[0];
    }

    const existing = await this.findExact(input);
    if (!existing) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Starting entity path is not active"
      );
    }
    return existing;
  }
}
