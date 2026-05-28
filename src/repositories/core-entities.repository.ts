import { SQL_QUERIES } from "../db/sql-queries.js";
import type { BrandRow, CategoryRow, ProductRow, UseContextRow } from "../types/database.types.js";
import { BaseRepository } from "./base.repository.js";

export class CoreEntitiesRepository extends BaseRepository {
  async getActiveCategoryById(categoryId: number): Promise<CategoryRow | null> {
    return this.executeSingleQuery<CategoryRow>(SQL_QUERIES.coreEntities.getActiveCategoryById, [categoryId]);
  }

  async getActiveBrandById(brandId: number): Promise<BrandRow | null> {
    return this.executeSingleQuery<BrandRow>(SQL_QUERIES.coreEntities.getActiveBrandById, [brandId]);
  }

  async getActiveProductById(productId: number): Promise<ProductRow | null> {
    return this.executeSingleQuery<ProductRow>(SQL_QUERIES.coreEntities.getActiveProductById, [productId]);
  }

  async getActiveUseContextById(contextId: number): Promise<UseContextRow | null> {
    return this.executeSingleQuery<UseContextRow>(SQL_QUERIES.coreEntities.getActiveUseContextById, [contextId]);
  }
}

export const coreEntitiesRepository = new CoreEntitiesRepository();
