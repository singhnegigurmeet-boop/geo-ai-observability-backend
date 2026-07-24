import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  BrandRow,
  CategoryRow,
  ProductRow,
  UseContextRow
} from "../types/database.types.js";

export type HierarchyRelationship = {
  domainId: string;
  categoryId: string;
  brandId?: string;
  productId?: string;
  useContextId?: string;
};

export class HierarchyRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  findActiveCategory(categoryId: string) {
    return this.findActive<CategoryRow>(
      "categories",
      "category_id",
      categoryId
    );
  }

  findActiveBrand(brandId: string) {
    return this.findActive<BrandRow>("brands", "brand_id", brandId);
  }

  findActiveProduct(productId: string) {
    return this.findActive<ProductRow>("products", "product_id", productId);
  }

  findActiveUseContext(useContextId: string) {
    return this.findActive<UseContextRow>(
      "use_contexts",
      "use_context_id",
      useContextId
    );
  }

  async relationshipExists(input: HierarchyRelationship) {
    const conditions = [
      "domain_id = $1",
      "category_id = $2",
      "is_active"
    ];
    const values: string[] = [input.domainId, input.categoryId];

    for (const [column, value] of [
      ["brand_id", input.brandId],
      ["product_id", input.productId],
      ["use_context_id", input.useContextId]
    ] as const) {
      if (value) {
        values.push(value);
        conditions.push(`${column} = $${values.length}`);
      }
    }

    const result = await this.database.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM entity_paths
          WHERE ${conditions.join("\n            AND ")}
        ) AS exists
      `,
      values
    );
    return result.rows[0]?.exists ?? false;
  }

  private async findActive<TRow extends Record<string, unknown>>(
    table: "categories" | "brands" | "products" | "use_contexts",
    idColumn:
      | "category_id"
      | "brand_id"
      | "product_id"
      | "use_context_id",
    id: string
  ) {
    const result = await this.database.query<TRow>(
      `
        SELECT *
        FROM ${table}
        WHERE ${idColumn} = $1
          AND is_active
      `,
      [id]
    );
    return result.rows[0] ?? null;
  }
}
