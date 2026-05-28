import { SQL_QUERIES } from "../db/sql-queries.js";
import type { EntityPathInput, EntityPathRow } from "../types/database.types.js";
import { BaseRepository } from "./base.repository.js";

export type ProductUseContextPathRow = EntityPathRow & {
  context: string;
};

export class EntityPathsRepository extends BaseRepository<EntityPathRow> {
  async getTopCategoryPathsForDomain(domainId: number, limit: number = 5): Promise<EntityPathRow[]> {
    return this.executeQuery<EntityPathRow>(SQL_QUERIES.entityPaths.getTopCategoryPathsForDomain, [
      domainId,
      limit
    ]);
  }

  async validateCategoryPath(domainId: number, categoryId: number): Promise<EntityPathRow | null> {
    return this.executeSingleQuery<EntityPathRow>(SQL_QUERIES.entityPaths.validateCategoryPath, [
      domainId,
      categoryId
    ]);
  }

  async validateBrandPath(domainId: number, categoryId: number, brandId: number): Promise<EntityPathRow | null> {
    return this.executeSingleQuery<EntityPathRow>(SQL_QUERIES.entityPaths.validateBrandPath, [
      domainId,
      categoryId,
      brandId
    ]);
  }

  async validateProductContextPath(
    domainId: number,
    categoryId: number,
    brandId: number,
    productId: number,
    contextId: number
  ): Promise<EntityPathRow | null> {
    return this.executeSingleQuery<EntityPathRow>(SQL_QUERIES.entityPaths.validateProductContextPath, [
      domainId,
      categoryId,
      brandId,
      productId,
      contextId
    ]);
  }

  async getUseContextsForProductPath(
    domainId: number,
    categoryId: number,
    brandId: number,
    productId: number
  ): Promise<ProductUseContextPathRow[]> {
    return this.executeQuery<ProductUseContextPathRow>(SQL_QUERIES.entityPaths.getUseContextsForProductPath, [
      domainId,
      categoryId,
      brandId,
      productId
    ]);
  }

  async createEntityPath(input: EntityPathInput): Promise<EntityPathRow> {
    return this.executeSingleQueryOrThrow<EntityPathRow>(
      SQL_QUERIES.entityPaths.createEntityPath,
      [
        input.domainId,
        input.categoryId,
        input.brandId ?? null,
        input.productId ?? null,
        input.contextId ?? null,
        input.pathType
      ],
      "Failed to create entity path"
    );
  }

  async listActivePathsForDomain(domainId: number): Promise<EntityPathRow[]> {
    return this.executeQuery<EntityPathRow>(SQL_QUERIES.entityPaths.listActivePathsForDomain, [domainId]);
  }
}

export const entityPathsRepository = new EntityPathsRepository();
