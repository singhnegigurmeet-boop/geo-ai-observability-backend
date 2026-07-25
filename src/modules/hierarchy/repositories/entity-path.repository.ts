import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import { ApplicationError } from "../../../common/errors/application-error.js";
import type {
  EntityPathRow,
  EntityPathType
} from "../../../common/types/database.types.js";

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

  async findActiveValidated(entityPathId: string) {
    const result = await this.database.query<EntityPathRow>(
      `
        SELECT path.*
        FROM entity_paths AS path
        JOIN domains AS domain
          ON domain.domain_id = path.domain_id AND domain.is_active
        LEFT JOIN categories AS category
          ON category.category_id = path.category_id AND category.is_active
        LEFT JOIN domain_categories AS domain_category
          ON domain_category.domain_id = path.domain_id
         AND domain_category.category_id = path.category_id
         AND domain_category.is_active
        LEFT JOIN brands AS brand
          ON brand.brand_id = path.brand_id AND brand.is_active
        LEFT JOIN category_brands AS category_brand
          ON category_brand.domain_category_id =
             domain_category.domain_category_id
         AND category_brand.brand_id = path.brand_id
         AND category_brand.is_active
        LEFT JOIN products AS product
          ON product.product_id = path.product_id AND product.is_active
        LEFT JOIN brand_products AS brand_product
          ON brand_product.category_brand_id =
             category_brand.category_brand_id
         AND brand_product.product_id = path.product_id
         AND brand_product.is_active
        LEFT JOIN use_contexts AS use_context
          ON use_context.use_context_id = path.use_context_id
         AND use_context.is_active
        LEFT JOIN product_use_contexts AS product_use_context
          ON product_use_context.brand_product_id =
             brand_product.brand_product_id
         AND product_use_context.use_context_id = path.use_context_id
         AND product_use_context.is_active
        WHERE path.entity_path_id = $1
          AND path.is_active
          AND (
            path.category_id IS NULL
            OR (
              category.category_id IS NOT NULL
              AND domain_category.domain_category_id IS NOT NULL
            )
          )
          AND (
            path.brand_id IS NULL
            OR (
              brand.brand_id IS NOT NULL
              AND category_brand.category_brand_id IS NOT NULL
            )
          )
          AND (
            path.product_id IS NULL
            OR (
              product.product_id IS NOT NULL
              AND brand_product.brand_product_id IS NOT NULL
            )
          )
          AND (
            path.use_context_id IS NULL
            OR (
              use_context.use_context_id IS NOT NULL
              AND product_use_context.product_use_context_id IS NOT NULL
            )
          )
      `,
      [entityPathId]
    );
    return result.rows[0] ?? null;
  }

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
