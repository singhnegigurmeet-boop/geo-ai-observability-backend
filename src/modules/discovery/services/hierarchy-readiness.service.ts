import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import type { EntityPathRow } from "../../../common/types/database.types.js";

export class HierarchyReadinessService {
  constructor(private readonly database: DatabaseExecutor) {}

  async isReady(path: EntityPathRow, categoryIds: readonly string[]) {
    if (path.path_type === "use_context") return true;
    const predicate = path.path_type === "domain"
      ? `dc.domain_id=$1 AND dc.category_id=ANY($2::bigint[])`
      : path.path_type === "category"
        ? `dc.domain_id=$1 AND dc.category_id=$2`
        : path.path_type === "brand"
          ? `dc.domain_id=$1 AND dc.category_id=$2 AND cb.brand_id=$3`
          : `dc.domain_id=$1 AND dc.category_id=$2 AND cb.brand_id=$3 AND bp.product_id=$4`;
    const joins = path.path_type === "product"
      ? `JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active
         JOIN brand_products bp ON bp.category_brand_id=cb.category_brand_id AND bp.is_active
         JOIN product_use_contexts puc ON puc.brand_product_id=bp.brand_product_id AND puc.is_active
         JOIN use_contexts uc ON uc.use_context_id=puc.use_context_id AND uc.is_active`
      : `JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active
         JOIN brands b ON b.brand_id=cb.brand_id AND b.is_active
         JOIN brand_products bp ON bp.category_brand_id=cb.category_brand_id AND bp.is_active
         JOIN products p ON p.product_id=bp.product_id AND p.is_active
         JOIN product_use_contexts puc ON puc.brand_product_id=bp.brand_product_id AND puc.is_active
         JOIN use_contexts uc ON uc.use_context_id=puc.use_context_id AND uc.is_active`;
    const result = await this.database.query<{ ready: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM domain_categories dc ${joins}
       WHERE dc.is_active AND ${predicate}) AS ready`,
      readinessParameters(path, categoryIds)
    );
    return result.rows[0]?.ready ?? false;
  }

  async hasViableTarget(path: EntityPathRow, categoryIds: readonly string[]) {
    if (path.path_type === "use_context") return true;
    const sql = path.path_type === "domain"
      ? `SELECT EXISTS(SELECT 1 FROM domain_categories dc JOIN categories c ON c.category_id=dc.category_id AND c.is_active WHERE dc.domain_id=$1 AND dc.category_id=ANY($2::bigint[]) AND dc.is_active) AS viable`
      : path.path_type === "category"
        ? `SELECT EXISTS(SELECT 1 FROM domain_categories dc JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active JOIN brands b ON b.brand_id=cb.brand_id AND b.is_active WHERE dc.domain_id=$1 AND dc.category_id=$2 AND dc.is_active) AS viable`
        : path.path_type === "brand"
          ? `SELECT EXISTS(SELECT 1 FROM domain_categories dc JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active JOIN brand_products bp ON bp.category_brand_id=cb.category_brand_id AND bp.is_active JOIN products p ON p.product_id=bp.product_id AND p.is_active WHERE dc.domain_id=$1 AND dc.category_id=$2 AND cb.brand_id=$3 AND dc.is_active) AS viable`
          : `SELECT EXISTS(SELECT 1 FROM domain_categories dc JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active JOIN brand_products bp ON bp.category_brand_id=cb.category_brand_id AND bp.is_active JOIN product_use_contexts puc ON puc.brand_product_id=bp.brand_product_id AND puc.is_active JOIN use_contexts uc ON uc.use_context_id=puc.use_context_id AND uc.is_active WHERE dc.domain_id=$1 AND dc.category_id=$2 AND cb.brand_id=$3 AND bp.product_id=$4 AND dc.is_active) AS viable`;
    const result = await this.database.query<{ viable: boolean }>(sql, readinessParameters(path, categoryIds));
    return result.rows[0]?.viable ?? false;
  }
}

function readinessParameters(path: EntityPathRow, categoryIds: readonly string[]) {
  if (path.path_type === "domain") return [path.domain_id, categoryIds];
  if (path.path_type === "category") return [path.domain_id, path.category_id];
  if (path.path_type === "brand") return [path.domain_id, path.category_id, path.brand_id];
  return [path.domain_id, path.category_id, path.brand_id, path.product_id];
}
