import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import { ApplicationError } from "../../../common/errors/application-error.js";
import type { EntityPathType } from "../../../common/types/database.types.js";
import { DomainRepository } from "../repositories/domain.repository.js";
import { normalizeDomain } from "../../../utils/domain-normalizer.js";
import { EntityPathRepository } from "../repositories/entity-path.repository.js";
import { HierarchyRelationshipsRepository } from "../repositories/hierarchy-relationships.repository.js";
import { HierarchyRepository } from "../repositories/hierarchy.repository.js";

export type ResolveStartingPathInput = {
  domain: string;
  categoryId: string | null;
  brandId: string | null;
  productId: string | null;
  useContextId: string | null;
};

export type ValidatedHierarchyChain = {
  domainCategoryId?: string;
  categoryBrandId?: string;
  brandProductId?: string;
  productUseContextId?: string;
};

export class HierarchyService {
  async resolveStartingPath(
    database: DatabaseExecutor,
    input: ResolveStartingPathInput
  ) {
    const normalizedDomain = normalizeDomain(input.domain);
    const domains = new DomainRepository(database);
    const hierarchy = new HierarchyRepository(database);
    const relationships = new HierarchyRelationshipsRepository(database);
    const paths = new EntityPathRepository(database);
    const domain = await domains.findOrCreate(normalizedDomain);

    if (
      input.categoryId &&
      !(await hierarchy.findActiveCategory(input.categoryId))
    ) {
      throw notFound("Category");
    }
    if (input.brandId && !(await hierarchy.findActiveBrand(input.brandId))) {
      throw notFound("Brand");
    }
    if (
      input.productId &&
      !(await hierarchy.findActiveProduct(input.productId))
    ) {
      throw notFound("Product");
    }
    if (
      input.useContextId &&
      !(await hierarchy.findActiveUseContext(input.useContextId))
    ) {
      throw notFound("Use context");
    }

    const chain: ValidatedHierarchyChain = {};
    if (input.categoryId) {
      const domainCategory =
        await relationships.findActiveDomainCategory(
          domain.domain_id,
          input.categoryId
        );
      if (!domainCategory) {
        throw missingRelationship("Category");
      }
      chain.domainCategoryId = domainCategory.domain_category_id;
    }
    if (input.brandId) {
      const categoryBrand =
        await relationships.findActiveCategoryBrand(
          chain.domainCategoryId as string,
          input.brandId
        );
      if (!categoryBrand) {
        throw missingRelationship("Brand");
      }
      chain.categoryBrandId = categoryBrand.category_brand_id;
    }
    if (input.productId) {
      const brandProduct =
        await relationships.findActiveBrandProduct(
          chain.categoryBrandId as string,
          input.productId
        );
      if (!brandProduct) {
        throw missingRelationship("Product");
      }
      chain.brandProductId = brandProduct.brand_product_id;
    }
    if (input.useContextId) {
      const productUseContext =
        await relationships.findActiveProductUseContext(
          chain.brandProductId as string,
          input.useContextId
        );
      if (!productUseContext) {
        throw missingRelationship("Use context");
      }
      chain.productUseContextId =
        productUseContext.product_use_context_id;
    }

    const path = await paths.findOrCreate({
      domainId: domain.domain_id,
      categoryId: input.categoryId,
      brandId: input.brandId,
      productId: input.productId,
      useContextId: input.useContextId,
      pathType: pathTypeFor(input)
    });

    return { domain, normalizedDomain, path, chain };
  }
}

function pathTypeFor(input: ResolveStartingPathInput): EntityPathType {
  if (input.useContextId) return "use_context";
  if (input.productId) return "product";
  if (input.brandId) return "brand";
  if (input.categoryId) return "category";
  return "domain";
}

function missingRelationship(entityName: string) {
  return new ApplicationError(
    "VALIDATION_ERROR",
    `${entityName} does not belong to the selected parent context`
  );
}

function notFound(entityName: string) {
  return new ApplicationError("NOT_FOUND", `${entityName} was not found`);
}
