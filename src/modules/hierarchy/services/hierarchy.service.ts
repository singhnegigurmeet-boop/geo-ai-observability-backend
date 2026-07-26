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
  async validateStartingPath(
    database: DatabaseExecutor,
    input: ResolveStartingPathInput
  ) {
    const normalizedDomain = normalizeDomain(input.domain);
    const domains = new DomainRepository(database);
    const hierarchy = new HierarchyRepository(database);
    const relationships = new HierarchyRelationshipsRepository(database);
    const paths = new EntityPathRepository(database);
    const domain = await domains.findByNormalizedDomain(normalizedDomain);

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
    if (!domain && input.categoryId) {
      throw missingRelationship("Category");
    }

    const chain = domain
      ? await validateRelationshipChain(relationships, domain.domain_id, input)
      : {};
    const pathType = pathTypeFor(input);
    const path = domain
      ? await paths.findExact({
          domainId: domain.domain_id,
          categoryId: input.categoryId,
          brandId: input.brandId,
          productId: input.productId,
          useContextId: input.useContextId,
          pathType
        })
      : null;
    return { domain, normalizedDomain, path, pathType, chain };
  }

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

    const chain = await validateRelationshipChain(
      relationships,
      domain.domain_id,
      input
    );

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

async function validateRelationshipChain(
  relationships: HierarchyRelationshipsRepository,
  domainId: string,
  input: ResolveStartingPathInput
) {
  const chain: ValidatedHierarchyChain = {};
  if (input.categoryId) {
    const row = await relationships.findActiveDomainCategory(
      domainId,
      input.categoryId
    );
    if (!row) throw missingRelationship("Category");
    chain.domainCategoryId = row.domain_category_id;
  }
  if (input.brandId) {
    const row = await relationships.findActiveCategoryBrand(
      chain.domainCategoryId as string,
      input.brandId
    );
    if (!row) throw missingRelationship("Brand");
    chain.categoryBrandId = row.category_brand_id;
  }
  if (input.productId) {
    const row = await relationships.findActiveBrandProduct(
      chain.categoryBrandId as string,
      input.productId
    );
    if (!row) throw missingRelationship("Product");
    chain.brandProductId = row.brand_product_id;
  }
  if (input.useContextId) {
    const row = await relationships.findActiveProductUseContext(
      chain.brandProductId as string,
      input.useContextId
    );
    if (!row) throw missingRelationship("Use context");
    chain.productUseContextId = row.product_use_context_id;
  }
  return chain;
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
