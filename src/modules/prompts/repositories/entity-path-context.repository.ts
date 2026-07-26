import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type { EntityPathType } from "../../../common/types/database.types.js";
import type { EntityPathContext } from "../types/prompt-rendering.types.js";

type EntityPathContextRecord = {
  domain_id: string;
  normalized_domain: string;
  category_id: string | null;
  category_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  product_id: string | null;
  product_name: string | null;
  use_context_id: string | null;
  use_context_name: string | null;
  starting_level: EntityPathType;
  target_level: EntityPathType;
};

export class EntityPathContextRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async find(
    entityPathId: string,
    startingEntityPathId: string
  ): Promise<EntityPathContext | null> {
    const result = await this.database.query<EntityPathContextRecord>(
      `
        SELECT
          path.domain_id,
          domain.normalized_domain,
          path.category_id,
          category.category_name,
          path.brand_id,
          brand.brand_name,
          path.product_id,
          product.product_name,
          path.use_context_id,
          use_context.use_context_name,
          starting_path.path_type AS starting_level,
          path.path_type AS target_level
        FROM entity_paths AS path
        JOIN entity_paths AS starting_path
          ON starting_path.entity_path_id = $2 AND starting_path.is_active
        JOIN domains AS domain
          ON domain.domain_id = path.domain_id AND domain.is_active
        LEFT JOIN categories AS category
          ON category.category_id = path.category_id AND category.is_active
        LEFT JOIN brands AS brand
          ON brand.brand_id = path.brand_id AND brand.is_active
        LEFT JOIN products AS product
          ON product.product_id = path.product_id AND product.is_active
        LEFT JOIN use_contexts AS use_context
          ON use_context.use_context_id = path.use_context_id
         AND use_context.is_active
        WHERE path.entity_path_id = $1 AND path.is_active
      `,
      [entityPathId, startingEntityPathId]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (
      (row.category_id !== null && row.category_name === null) ||
      (row.brand_id !== null && row.brand_name === null) ||
      (row.product_id !== null && row.product_name === null) ||
      (row.use_context_id !== null && row.use_context_name === null)
    ) {
      return null;
    }
    const context: EntityPathContext = {
      domain: { id: row.domain_id, name: row.normalized_domain },
      startingLevel: row.starting_level,
      targetLevel: row.target_level,
      canonicalPath: [
        row.normalized_domain,
        row.category_name,
        row.brand_name,
        row.product_name,
        row.use_context_name
      ]
        .filter((part): part is string => part !== null)
        .join(" > ")
    };
    if (row.category_id && row.category_name) {
      context.category = { id: row.category_id, name: row.category_name };
    }
    if (row.brand_id && row.brand_name) {
      context.brand = { id: row.brand_id, name: row.brand_name };
    }
    if (row.product_id && row.product_name) {
      context.product = { id: row.product_id, name: row.product_name };
    }
    if (row.use_context_id && row.use_context_name) {
      context.useContext = {
        id: row.use_context_id,
        name: row.use_context_name
      };
    }
    return context;
  }
}
