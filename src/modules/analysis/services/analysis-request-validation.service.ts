import { normalizeDomain } from "../../../utils/domain-normalization.js";
import type { DomainRow, EntityPathRow } from "../../../types/database.types.js";
import type {
  AnalysisBrandSelection,
  AnalysisCategorySelection,
  AnalysisProductSelection,
  AnalysisRequest
} from "../types/v6-analysis-request.js";

export class AnalysisRequestValidationError extends Error {
  constructor(
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export type ValidatedAnalysisPath =
  | {
      pathType: "category";
      domainId: number;
      categoryId: number;
      pathId: number;
    }
  | {
      pathType: "brand";
      domainId: number;
      categoryId: number;
      brandId: number;
      pathId: number;
    }
  | {
      pathType: "product";
      domainId: number;
      categoryId: number;
      brandId: number;
      productId: number;
      useContextIds: number[];
      pathIds: number[];
      useContextSelectionRequired: boolean;
    };

export type ValidatedAnalysisRequest = {
  domain: DomainRow;
  normalizedDomain: string;
  paths: ValidatedAnalysisPath[];
  useContextSelectionRequired: boolean;
};

export type AnalysisValidationDependencies = {
  domainsRepository: {
    getActiveDomainByName(domain: string): Promise<DomainRow | null>;
  };
  entityPathsRepository: {
    getTopCategoryPathsForDomain(domainId: number, limit?: number): Promise<EntityPathRow[]>;
    validateCategoryPath(domainId: number, categoryId: number): Promise<EntityPathRow | null>;
    validateBrandPath(domainId: number, categoryId: number, brandId: number): Promise<EntityPathRow | null>;
    validateProductContextPath(
      domainId: number,
      categoryId: number,
      brandId: number,
      productId: number,
      contextId: number
    ): Promise<EntityPathRow | null>;
    getUseContextsForProductPath(
      domainId: number,
      categoryId: number,
      brandId: number,
      productId: number
    ): Promise<EntityPathRow[]>;
  };
};

export class AnalysisRequestValidationService {
  constructor(private readonly dependencies: AnalysisValidationDependencies) {}

  async validateRequest(request: AnalysisRequest): Promise<ValidatedAnalysisRequest> {
    const normalizedDomain = normalizeDomain(request.domain);
    const domain = await this.dependencies.domainsRepository.getActiveDomainByName(normalizedDomain);

    if (!domain) {
      throw new AnalysisRequestValidationError("Domain is not active or does not exist", {
        domain: normalizedDomain
      });
    }

    if (!request.categories || request.categories.length === 0) {
      const categoryPaths = await this.dependencies.entityPathsRepository.getTopCategoryPathsForDomain(
        domain.domain_id,
        5
      );

      return {
        domain,
        normalizedDomain,
        paths: categoryPaths.map((path) => this.toCategoryPath(path)),
        useContextSelectionRequired: false
      };
    }

    if (request.categories.length > 5) {
      throw new AnalysisRequestValidationError("A maximum of 5 categories can be analyzed at once");
    }

    const paths: ValidatedAnalysisPath[] = [];
    let useContextSelectionRequired = false;

    for (const category of request.categories) {
      const categoryPaths = await this.validateCategorySelection(domain.domain_id, category);
      paths.push(...categoryPaths.paths);
      useContextSelectionRequired = useContextSelectionRequired || categoryPaths.useContextSelectionRequired;
    }

    return {
      domain,
      normalizedDomain,
      paths,
      useContextSelectionRequired
    };
  }

  private async validateCategorySelection(domainId: number, category: AnalysisCategorySelection) {
    if (!category.brands || category.brands.length === 0) {
      const categoryPath = await this.dependencies.entityPathsRepository.validateCategoryPath(
        domainId,
        category.categoryId
      );
      if (!categoryPath) {
        throw new AnalysisRequestValidationError("Invalid domain/category path", {
          domainId,
          categoryId: category.categoryId
        });
      }

      return {
        paths: [this.toCategoryPath(categoryPath)],
        useContextSelectionRequired: false
      };
    }

    if (category.brands.length > 5) {
      throw new AnalysisRequestValidationError("A maximum of 5 brands can be analyzed per category", {
        categoryId: category.categoryId
      });
    }

    const paths: ValidatedAnalysisPath[] = [];
    let useContextSelectionRequired = false;

    for (const brand of category.brands) {
      const brandPaths = await this.validateBrandSelection(domainId, category.categoryId, brand);
      paths.push(...brandPaths.paths);
      useContextSelectionRequired = useContextSelectionRequired || brandPaths.useContextSelectionRequired;
    }

    return { paths, useContextSelectionRequired };
  }

  private async validateBrandSelection(domainId: number, categoryId: number, brand: AnalysisBrandSelection) {
    const brandPath = await this.dependencies.entityPathsRepository.validateBrandPath(
      domainId,
      categoryId,
      brand.brandId
    );
    if (!brandPath) {
      throw new AnalysisRequestValidationError("Invalid domain/category/brand path", {
        domainId,
        categoryId,
        brandId: brand.brandId
      });
    }

    if (!brand.products || brand.products.length === 0) {
      return {
        paths: [this.toBrandPath(brandPath)],
        useContextSelectionRequired: false
      };
    }

    if (brand.products.length > 5) {
      throw new AnalysisRequestValidationError("A maximum of 5 products can be analyzed per brand", {
        categoryId,
        brandId: brand.brandId
      });
    }

    const paths: ValidatedAnalysisPath[] = [];
    let useContextSelectionRequired = false;

    for (const product of brand.products) {
      const productPath = await this.validateProductSelection(domainId, categoryId, brand.brandId, product);
      paths.push(productPath);
      useContextSelectionRequired = useContextSelectionRequired || productPath.useContextSelectionRequired;
    }

    return { paths, useContextSelectionRequired };
  }

  private async validateProductSelection(
    domainId: number,
    categoryId: number,
    brandId: number,
    product: AnalysisProductSelection
  ): Promise<Extract<ValidatedAnalysisPath, { pathType: "product" }>> {
    if (!product.useContextIds || product.useContextIds.length === 0) {
      const allowedContexts = await this.dependencies.entityPathsRepository.getUseContextsForProductPath(
        domainId,
        categoryId,
        brandId,
        product.productId
      );
      if (allowedContexts.length === 0) {
        throw new AnalysisRequestValidationError("Invalid domain/category/brand/product path", {
          domainId,
          categoryId,
          brandId,
          productId: product.productId
        });
      }

      return {
        pathType: "product",
        domainId,
        categoryId,
        brandId,
        productId: product.productId,
        useContextIds: [],
        pathIds: [],
        useContextSelectionRequired: true
      };
    }

    const validatedPaths: EntityPathRow[] = [];
    for (const contextId of product.useContextIds) {
      const productContextPath = await this.dependencies.entityPathsRepository.validateProductContextPath(
        domainId,
        categoryId,
        brandId,
        product.productId,
        contextId
      );
      if (!productContextPath) {
        throw new AnalysisRequestValidationError("Invalid domain/category/brand/product/use_context path", {
          domainId,
          categoryId,
          brandId,
          productId: product.productId,
          contextId
        });
      }

      validatedPaths.push(productContextPath);
    }

    return {
      pathType: "product",
      domainId,
      categoryId,
      brandId,
      productId: product.productId,
      useContextIds: product.useContextIds,
      pathIds: validatedPaths.map((path) => path.path_id),
      useContextSelectionRequired: false
    };
  }

  private toCategoryPath(path: EntityPathRow): Extract<ValidatedAnalysisPath, { pathType: "category" }> {
    return {
      pathType: "category",
      domainId: path.domain_id,
      categoryId: path.category_id,
      pathId: path.path_id
    };
  }

  private toBrandPath(path: EntityPathRow): Extract<ValidatedAnalysisPath, { pathType: "brand" }> {
    return {
      pathType: "brand",
      domainId: path.domain_id,
      categoryId: path.category_id,
      brandId: path.brand_id as number,
      pathId: path.path_id
    };
  }
}
