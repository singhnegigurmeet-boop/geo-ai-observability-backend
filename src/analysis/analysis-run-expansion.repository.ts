import type { DatabaseExecutor } from "../db/database-executor.js";
import type {
  AnalysisRunRow,
  EntityPathRow
} from "../types/database.types.js";

export type ExpansionChild = {
  domainId: string;
  categoryId: string | null;
  brandId: string | null;
  productId: string | null;
  useContextId: string | null;
  pathType: EntityPathRow["path_type"];
};

export class AnalysisRunExpansionRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findRunForUpdate(analysisRunId: string) {
    const result = await this.database.query<AnalysisRunRow>(
      "SELECT * FROM analysis_runs WHERE analysis_run_id = $1 FOR UPDATE",
      [analysisRunId]
    );
    return result.rows[0] ?? null;
  }

  async findActiveStartingPath(entityPathId: string) {
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

  async listActiveCategoryChildren(domainId: string, limit: number) {
    return this.children(
      `
        SELECT
          relationship.domain_category_id AS relationship_id,
          relationship.sort_order,
          relationship.created_at,
          relationship.category_id AS child_id
        FROM domain_categories AS relationship
        JOIN domains AS domain
          ON domain.domain_id = relationship.domain_id AND domain.is_active
        JOIN categories AS child
          ON child.category_id = relationship.category_id AND child.is_active
        WHERE relationship.domain_id = $1 AND relationship.is_active
        ORDER BY relationship.sort_order ASC NULLS LAST,
                 relationship.created_at ASC,
                 relationship.domain_category_id ASC
        LIMIT $2
      `,
      [domainId, limit],
      (childId) => ({
        domainId,
        categoryId: childId,
        brandId: null,
        productId: null,
        useContextId: null,
        pathType: "category"
      })
    );
  }

  async listActiveBrandChildren(path: EntityPathRow, limit: number) {
    return this.children(
      `
        SELECT
          child_relationship.category_brand_id AS relationship_id,
          child_relationship.sort_order,
          child_relationship.created_at,
          child_relationship.brand_id AS child_id
        FROM domain_categories AS parent
        JOIN category_brands AS child_relationship
          ON child_relationship.domain_category_id = parent.domain_category_id
         AND child_relationship.is_active
        JOIN brands AS child
          ON child.brand_id = child_relationship.brand_id AND child.is_active
        JOIN categories AS category
          ON category.category_id = parent.category_id AND category.is_active
        JOIN domains AS domain
          ON domain.domain_id = parent.domain_id AND domain.is_active
        WHERE parent.domain_id = $1
          AND parent.category_id = $2
          AND parent.is_active
        ORDER BY child_relationship.sort_order ASC NULLS LAST,
                 child_relationship.created_at ASC,
                 child_relationship.category_brand_id ASC
        LIMIT $3
      `,
      [path.domain_id, path.category_id, limit],
      (childId) => ({
        domainId: path.domain_id,
        categoryId: path.category_id,
        brandId: childId,
        productId: null,
        useContextId: null,
        pathType: "brand"
      })
    );
  }

  async listActiveProductChildren(path: EntityPathRow, limit: number) {
    return this.children(
      `
        SELECT
          child_relationship.brand_product_id AS relationship_id,
          child_relationship.sort_order,
          child_relationship.created_at,
          child_relationship.product_id AS child_id
        FROM domain_categories AS domain_category
        JOIN category_brands AS parent
          ON parent.domain_category_id = domain_category.domain_category_id
         AND parent.is_active
        JOIN brand_products AS child_relationship
          ON child_relationship.category_brand_id = parent.category_brand_id
         AND child_relationship.is_active
        JOIN products AS child
          ON child.product_id = child_relationship.product_id AND child.is_active
        JOIN categories AS category
          ON category.category_id = domain_category.category_id
         AND category.is_active
        JOIN brands AS brand
          ON brand.brand_id = parent.brand_id AND brand.is_active
        JOIN domains AS domain
          ON domain.domain_id = domain_category.domain_id AND domain.is_active
        WHERE domain_category.domain_id = $1
          AND domain_category.category_id = $2
          AND domain_category.is_active
          AND parent.brand_id = $3
        ORDER BY child_relationship.sort_order ASC NULLS LAST,
                 child_relationship.created_at ASC,
                 child_relationship.brand_product_id ASC
        LIMIT $4
      `,
      [path.domain_id, path.category_id, path.brand_id, limit],
      (childId) => ({
        domainId: path.domain_id,
        categoryId: path.category_id,
        brandId: path.brand_id,
        productId: childId,
        useContextId: null,
        pathType: "product"
      })
    );
  }

  async listActiveUseContextChildren(path: EntityPathRow, limit: number) {
    return this.children(
      `
        SELECT
          child_relationship.product_use_context_id AS relationship_id,
          child_relationship.sort_order,
          child_relationship.created_at,
          child_relationship.use_context_id AS child_id
        FROM domain_categories AS domain_category
        JOIN category_brands AS category_brand
          ON category_brand.domain_category_id = domain_category.domain_category_id
         AND category_brand.is_active
        JOIN brand_products AS parent
          ON parent.category_brand_id = category_brand.category_brand_id
         AND parent.is_active
        JOIN product_use_contexts AS child_relationship
          ON child_relationship.brand_product_id = parent.brand_product_id
         AND child_relationship.is_active
        JOIN use_contexts AS child
          ON child.use_context_id = child_relationship.use_context_id
         AND child.is_active
        JOIN categories AS category
          ON category.category_id = domain_category.category_id
         AND category.is_active
        JOIN brands AS brand
          ON brand.brand_id = category_brand.brand_id AND brand.is_active
        JOIN products AS product
          ON product.product_id = parent.product_id AND product.is_active
        JOIN domains AS domain
          ON domain.domain_id = domain_category.domain_id AND domain.is_active
        WHERE domain_category.domain_id = $1
          AND domain_category.category_id = $2
          AND domain_category.is_active
          AND category_brand.brand_id = $3
          AND parent.product_id = $4
        ORDER BY child_relationship.sort_order ASC NULLS LAST,
                 child_relationship.created_at ASC,
                 child_relationship.product_use_context_id ASC
        LIMIT $5
      `,
      [
        path.domain_id,
        path.category_id,
        path.brand_id,
        path.product_id,
        limit
      ],
      (childId) => ({
        domainId: path.domain_id,
        categoryId: path.category_id,
        brandId: path.brand_id,
        productId: path.product_id,
        useContextId: childId,
        pathType: "use_context"
      })
    );
  }

  async markProcessing(analysisRunId: string) {
    await this.database.query(
      `
        UPDATE analysis_runs
        SET status = 'processing',
            started_at = COALESCE(started_at, now()),
            completed_at = NULL,
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE analysis_run_id = $1 AND status = 'queued'
      `,
      [analysisRunId]
    );
  }

  async markNoExpansionChildren(analysisRunId: string, _message: string) {
    await this.database.query(
      `
        UPDATE analysis_runs
        SET status = 'completed',
            started_at = COALESCE(started_at, now()),
            completed_at = now(),
            error_code = NULL,
            error_message = NULL,
            updated_at = now()
        WHERE analysis_run_id = $1 AND status = 'queued'
      `,
      [analysisRunId]
    );
  }

  private async children(
    sql: string,
    values: unknown[],
    toChild: (childId: string) => ExpansionChild
  ) {
    const result = await this.database.query<{ child_id: string }>(sql, values);
    return result.rows.map((row) => toChild(row.child_id));
  }
}
