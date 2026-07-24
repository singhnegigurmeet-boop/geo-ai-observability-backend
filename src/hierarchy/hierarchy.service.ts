import type { DatabaseExecutor } from "../db/database-executor.js";
import { ApplicationError } from "../errors/application-error.js";
import type { EntityPathType } from "../types/database.types.js";
import { DomainRepository } from "./domain.repository.js";
import { normalizeDomain } from "./domain-normalizer.js";
import { EntityPathRepository } from "./entity-path.repository.js";
import { HierarchyRepository } from "./hierarchy.repository.js";

export type ResolveStartingPathInput = {
  domain: string;
  categoryId: string | null;
  brandId: string | null;
  productId: string | null;
  useContextId: string | null;
};

export class HierarchyService {
  async resolveStartingPath(
    database: DatabaseExecutor,
    input: ResolveStartingPathInput
  ) {
    const normalizedDomain = normalizeDomain(input.domain);
    const domains = new DomainRepository(database);
    const hierarchy = new HierarchyRepository(database);
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

    if (input.brandId) {
      await requireRelationship(hierarchy, "Brand", {
        domainId: domain.domain_id,
        categoryId: input.categoryId as string,
        brandId: input.brandId
      });
    }
    if (input.productId) {
      await requireRelationship(hierarchy, "Product", {
        domainId: domain.domain_id,
        categoryId: input.categoryId as string,
        brandId: input.brandId as string,
        productId: input.productId
      });
    }
    if (input.useContextId) {
      await requireRelationship(hierarchy, "Use context", {
        domainId: domain.domain_id,
        categoryId: input.categoryId as string,
        brandId: input.brandId as string,
        productId: input.productId as string,
        useContextId: input.useContextId
      });
    }

    const path = await paths.findOrCreate({
      domainId: domain.domain_id,
      categoryId: input.categoryId,
      brandId: input.brandId,
      productId: input.productId,
      useContextId: input.useContextId,
      pathType: pathTypeFor(input)
    });

    return { domain, normalizedDomain, path };
  }
}

function pathTypeFor(input: ResolveStartingPathInput): EntityPathType {
  if (input.useContextId) return "use_context";
  if (input.productId) return "product";
  if (input.brandId) return "brand";
  if (input.categoryId) return "category";
  return "domain";
}

async function requireRelationship(
  hierarchy: HierarchyRepository,
  entityName: string,
  input: Parameters<HierarchyRepository["relationshipExists"]>[0]
) {
  if (!(await hierarchy.relationshipExists(input))) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      `${entityName} does not belong to the selected parent context`
    );
  }
}

function notFound(entityName: string) {
  return new ApplicationError("NOT_FOUND", `${entityName} was not found`);
}
