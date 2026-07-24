import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  BrandRow,
  CategoryRow,
  ProductRow,
  UseContextRow
} from "../types/database.types.js";

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
