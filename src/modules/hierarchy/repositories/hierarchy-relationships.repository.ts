import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type {
  BrandProductRow,
  CategoryBrandRow,
  DomainCategoryRow,
  ProductUseContextRow
} from "../../../common/types/database.types.js";

export type ActiveCategoryRelationship = DomainCategoryRow & {
  category_name: string;
  category_normalized_name: string;
};

export type ActiveBrandRelationship = CategoryBrandRow & {
  brand_name: string;
  brand_normalized_name: string;
};

export type ActiveProductRelationship = BrandProductRow & {
  product_name: string;
  product_normalized_name: string;
};

export type ActiveUseContextRelationship = ProductUseContextRow & {
  use_context_name: string;
  use_context_normalized_name: string;
};

export class HierarchyRelationshipsRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findActiveDomainCategory(domainId: string, categoryId: string) {
    const result = await this.database.query<DomainCategoryRow>(
      `
        SELECT relationship.*
        FROM domain_categories AS relationship
        JOIN domains AS domain
          ON domain.domain_id = relationship.domain_id
         AND domain.is_active
        JOIN categories AS category
          ON category.category_id = relationship.category_id
         AND category.is_active
        WHERE relationship.domain_id = $1
          AND relationship.category_id = $2
          AND relationship.is_active
      `,
      [domainId, categoryId]
    );
    return result.rows[0] ?? null;
  }

  async findActiveCategoryBrand(
    domainCategoryId: string,
    brandId: string
  ) {
    const result = await this.database.query<CategoryBrandRow>(
      `
        SELECT relationship.*
        FROM category_brands AS relationship
        JOIN domain_categories AS parent
          ON parent.domain_category_id = relationship.domain_category_id
         AND parent.is_active
        JOIN domains AS domain
          ON domain.domain_id = parent.domain_id
         AND domain.is_active
        JOIN categories AS category
          ON category.category_id = parent.category_id
         AND category.is_active
        JOIN brands AS brand
          ON brand.brand_id = relationship.brand_id
         AND brand.is_active
        WHERE relationship.domain_category_id = $1
          AND relationship.brand_id = $2
          AND relationship.is_active
      `,
      [domainCategoryId, brandId]
    );
    return result.rows[0] ?? null;
  }

  async findActiveBrandProduct(
    categoryBrandId: string,
    productId: string
  ) {
    const result = await this.database.query<BrandProductRow>(
      `
        SELECT relationship.*
        FROM brand_products AS relationship
        JOIN category_brands AS parent
          ON parent.category_brand_id = relationship.category_brand_id
         AND parent.is_active
        JOIN domain_categories AS domain_category
          ON domain_category.domain_category_id = parent.domain_category_id
         AND domain_category.is_active
        JOIN domains AS domain
          ON domain.domain_id = domain_category.domain_id
         AND domain.is_active
        JOIN categories AS category
          ON category.category_id = domain_category.category_id
         AND category.is_active
        JOIN brands AS brand
          ON brand.brand_id = parent.brand_id
         AND brand.is_active
        JOIN products AS product
          ON product.product_id = relationship.product_id
         AND product.is_active
        WHERE relationship.category_brand_id = $1
          AND relationship.product_id = $2
          AND relationship.is_active
      `,
      [categoryBrandId, productId]
    );
    return result.rows[0] ?? null;
  }

  async findActiveProductUseContext(
    brandProductId: string,
    useContextId: string
  ) {
    const result = await this.database.query<ProductUseContextRow>(
      `
        SELECT relationship.*
        FROM product_use_contexts AS relationship
        JOIN brand_products AS parent
          ON parent.brand_product_id = relationship.brand_product_id
         AND parent.is_active
        JOIN category_brands AS category_brand
          ON category_brand.category_brand_id = parent.category_brand_id
         AND category_brand.is_active
        JOIN domain_categories AS domain_category
          ON domain_category.domain_category_id =
             category_brand.domain_category_id
         AND domain_category.is_active
        JOIN domains AS domain
          ON domain.domain_id = domain_category.domain_id
         AND domain.is_active
        JOIN categories AS category
          ON category.category_id = domain_category.category_id
         AND category.is_active
        JOIN brands AS brand
          ON brand.brand_id = category_brand.brand_id
         AND brand.is_active
        JOIN products AS product
          ON product.product_id = parent.product_id
         AND product.is_active
        JOIN use_contexts AS use_context
          ON use_context.use_context_id = relationship.use_context_id
         AND use_context.is_active
        WHERE relationship.brand_product_id = $1
          AND relationship.use_context_id = $2
          AND relationship.is_active
      `,
      [brandProductId, useContextId]
    );
    return result.rows[0] ?? null;
  }

  async listActiveCategories(domainId: string, limit: number) {
    const result = await this.database.query<ActiveCategoryRelationship>(
      `
        SELECT
          relationship.*,
          category.category_name,
          category.normalized_name AS category_normalized_name
        FROM domain_categories AS relationship
        JOIN domains AS domain
          ON domain.domain_id = relationship.domain_id
         AND domain.is_active
        JOIN categories AS category
          ON category.category_id = relationship.category_id
         AND category.is_active
        WHERE relationship.domain_id = $1
          AND relationship.is_active
        ORDER BY
          relationship.sort_order ASC NULLS LAST,
          relationship.created_at ASC,
          relationship.domain_category_id ASC
        LIMIT $2
      `,
      [domainId, limit]
    );
    return result.rows;
  }

  async listActiveBrands(domainCategoryId: string, limit: number) {
    const result = await this.database.query<ActiveBrandRelationship>(
      `
        SELECT
          relationship.*,
          brand.brand_name,
          brand.normalized_name AS brand_normalized_name
        FROM category_brands AS relationship
        JOIN domain_categories AS parent
          ON parent.domain_category_id = relationship.domain_category_id
         AND parent.is_active
        JOIN domains AS domain
          ON domain.domain_id = parent.domain_id
         AND domain.is_active
        JOIN categories AS category
          ON category.category_id = parent.category_id
         AND category.is_active
        JOIN brands AS brand
          ON brand.brand_id = relationship.brand_id
         AND brand.is_active
        WHERE relationship.domain_category_id = $1
          AND relationship.is_active
        ORDER BY
          relationship.sort_order ASC NULLS LAST,
          relationship.created_at ASC,
          relationship.category_brand_id ASC
        LIMIT $2
      `,
      [domainCategoryId, limit]
    );
    return result.rows;
  }

  async listActiveProducts(categoryBrandId: string, limit: number) {
    const result = await this.database.query<ActiveProductRelationship>(
      `
        SELECT
          relationship.*,
          product.product_name,
          product.normalized_name AS product_normalized_name
        FROM brand_products AS relationship
        JOIN category_brands AS parent
          ON parent.category_brand_id = relationship.category_brand_id
         AND parent.is_active
        JOIN domain_categories AS domain_category
          ON domain_category.domain_category_id = parent.domain_category_id
         AND domain_category.is_active
        JOIN domains AS domain
          ON domain.domain_id = domain_category.domain_id
         AND domain.is_active
        JOIN categories AS category
          ON category.category_id = domain_category.category_id
         AND category.is_active
        JOIN brands AS brand
          ON brand.brand_id = parent.brand_id
         AND brand.is_active
        JOIN products AS product
          ON product.product_id = relationship.product_id
         AND product.is_active
        WHERE relationship.category_brand_id = $1
          AND relationship.is_active
        ORDER BY
          relationship.sort_order ASC NULLS LAST,
          relationship.created_at ASC,
          relationship.brand_product_id ASC
        LIMIT $2
      `,
      [categoryBrandId, limit]
    );
    return result.rows;
  }

  async listActiveUseContexts(brandProductId: string, limit: number) {
    const result = await this.database.query<ActiveUseContextRelationship>(
      `
        SELECT
          relationship.*,
          use_context.use_context_name,
          use_context.normalized_name AS use_context_normalized_name
        FROM product_use_contexts AS relationship
        JOIN brand_products AS parent
          ON parent.brand_product_id = relationship.brand_product_id
         AND parent.is_active
        JOIN category_brands AS category_brand
          ON category_brand.category_brand_id = parent.category_brand_id
         AND category_brand.is_active
        JOIN domain_categories AS domain_category
          ON domain_category.domain_category_id =
             category_brand.domain_category_id
         AND domain_category.is_active
        JOIN domains AS domain
          ON domain.domain_id = domain_category.domain_id
         AND domain.is_active
        JOIN categories AS category
          ON category.category_id = domain_category.category_id
         AND category.is_active
        JOIN brands AS brand
          ON brand.brand_id = category_brand.brand_id
         AND brand.is_active
        JOIN products AS product
          ON product.product_id = parent.product_id
         AND product.is_active
        JOIN use_contexts AS use_context
          ON use_context.use_context_id = relationship.use_context_id
         AND use_context.is_active
        WHERE relationship.brand_product_id = $1
          AND relationship.is_active
        ORDER BY
          relationship.sort_order ASC NULLS LAST,
          relationship.created_at ASC,
          relationship.product_use_context_id ASC
        LIMIT $2
      `,
      [brandProductId, limit]
    );
    return result.rows;
  }
}
