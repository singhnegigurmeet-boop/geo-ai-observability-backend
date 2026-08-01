import type {
  DatabaseExecutor,
  TransactionPool
} from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import { ApplicationError } from "../../../common/errors/application-error.js";
import type { OwnershipContext } from "../../../common/ownership/ownership-context.types.js";
import type {
  EntityPathType,
  HierarchyDiscoveryStage,
  JsonObject,
  PreAnalysisRequestRow,
  ProviderName
} from "../../../common/types/database.types.js";
import { AnalysisRunRequestedCategoryRepository } from "../../analysis/repositories/analysis-run-requested-category.repository.js";
import { hashCanonical } from "../../analysis/services/canonical-analysis-planner.service.js";
import { HierarchyService } from "../../hierarchy/services/hierarchy.service.js";
import { OutboxEventWriterRepository } from "../../outbox/repositories/outbox-event-writer.repository.js";
import {
  ANONYMOUS_HIERARCHY_BREADTH,
  AUTHENTICATED_HIERARCHY_BREADTH,
  HIERARCHY_DISCOVERY_CONTRACT_VERSIONS,
  HIERARCHY_DISCOVERY_POLICY_VERSION,
  HIERARCHY_DISCOVERY_PROMPT_VERSIONS
} from "../../providers/contracts/provider-response.contracts.js";
import { resolveDiscoveryModel } from "../../providers/policies/provider-model.policy.js";
import { requireWorkspaceMutationRole } from "../../workspaces/services/workspace-authorization.service.js";
import { PreAnalysisRequestRepository } from "../repositories/pre-analysis-request.repository.js";

type NavigationDatabase = DatabaseExecutor & TransactionPool;

export type HierarchyNavigationRequest = {
  domain: string;
  categoryId?: string;
  brandId?: string;
  productId?: string;
};

export type HierarchyChild = {
  entityType: Exclude<EntityPathType, "domain">;
  entityId: string;
  name: string;
  path: {
    domain: string;
    categoryId: string | null;
    brandId: string | null;
    productId: string | null;
    useContextId: string | null;
  };
  canAnalyze: true;
  canContinue: boolean;
};

export class HierarchyNavigationService {
  constructor(
    private readonly database: NavigationDatabase,
    private readonly hierarchy = new HierarchyService(),
    private readonly discovery: {
      provider: ProviderName;
      model: string;
      fallbackProvider: ProviderName | null;
      fallbackModel: string | null;
      realProvidersEnabled: boolean;
    }
  ) {}

  async continue(
    request: HierarchyNavigationRequest,
    clientIdempotencyKey: string,
    owner: OwnershipContext
  ) {
    if (owner.actorType === "user") requireWorkspaceMutationRole(owner.workspaceRole);
    if (owner.actorType === "anonymous" && request.brandId) {
      throw new ApplicationError(
        "FORBIDDEN",
        "Anonymous actors may not continue beyond brand level"
      );
    }

    const validated = await this.hierarchy.validateStartingPath(this.database, {
      domain: request.domain,
      categoryId: request.categoryId ?? null,
      brandId: request.brandId ?? null,
      productId: request.productId ?? null,
      useContextId: null
    });
    const requestedStage = nextStage(validated.pathType);
    if (!requestedStage) {
      throw new ApplicationError("VALIDATION_ERROR", "Use context is a terminal hierarchy level");
    }
    if (validated.domain) {
      const children = await listImmediateChildren(this.database, {
        normalizedDomain: validated.normalizedDomain,
        domainId: validated.domain.domain_id,
        categoryId: request.categoryId ?? null,
        brandId: request.brandId ?? null,
        productId: request.productId ?? null,
        pathType: validated.pathType
      }, owner.actorType);
      if (children.length > 0) return databaseResponse(requestedStage, children, owner);
    }

    return inTransaction(this.database, async (client) => {
      const resolved = await this.hierarchy.resolveStartingPath(client, {
        domain: request.domain,
        categoryId: request.categoryId ?? null,
        brandId: request.brandId ?? null,
        productId: request.productId ?? null,
        useContextId: null
      });
      const primary = resolveDiscoveryModel({
        provider: this.discovery.provider,
        model: this.discovery.model,
        realProvidersEnabled: this.discovery.realProvidersEnabled
      });
      const fallback = this.discovery.fallbackProvider && this.discovery.fallbackModel
        ? resolveDiscoveryModel({
            provider: this.discovery.fallbackProvider,
            model: this.discovery.fallbackModel,
            realProvidersEnabled: this.discovery.realProvidersEnabled
          })
        : null;
      const categories = new AnalysisRunRequestedCategoryRepository(client);
      const frozenCategories = await categories.resolveActive({ mode: "all" });
      const categoryIds = frozenCategories.map((row) => row.category_id);
      const requestPayload = {
        operation: "navigate",
        requestedStage,
        domain: resolved.normalizedDomain,
        categoryId: request.categoryId ?? null,
        brandId: request.brandId ?? null,
        productId: request.productId ?? null,
        useContextId: null,
        categorySelection: { mode: "all", categoryIds },
        promptDepth: "weak",
        providerModels: [],
        discoveryProfile: {
          ...primary,
          fallback: fallback
            ? { provider: fallback.provider, model: fallback.model, modelProfileVersion: fallback.modelProfileVersion }
            : null,
          policyVersion: HIERARCHY_DISCOVERY_POLICY_VERSION,
          promptVersions: HIERARCHY_DISCOVERY_PROMPT_VERSIONS,
          contractVersions: HIERARCHY_DISCOVERY_CONTRACT_VERSIONS
        }
      } satisfies JsonObject;
      const canonicalRequestHash = hashCanonical({
        operation: "navigate",
        requestedStage,
        domain: resolved.normalizedDomain,
        categoryId: request.categoryId ?? null,
        brandId: request.brandId ?? null,
        productId: request.productId ?? null
      });
      const discoveryCompatibilityHash = hashCanonical({
        operation: "navigate",
        requestedStage,
        domainId: resolved.domain.domain_id,
        domainCategoryId: resolved.chain.domainCategoryId ?? null,
        categoryBrandId: resolved.chain.categoryBrandId ?? null,
        brandProductId: resolved.chain.brandProductId ?? null,
        categoryCandidateIds: requestedStage === "category" ? categoryIds : [],
        profile: requestPayload.discoveryProfile
      });
      const idempotencyKey = ownerScopedIdempotencyKey(owner, `navigate:${clientIdempotencyKey}`);
      const requests = new PreAnalysisRequestRepository(client);
      const existing = await requests.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.canonical_request_hash !== canonicalRequestHash) {
          throw new ApplicationError("CONFLICT", "Idempotency-Key was already used with a different hierarchy navigation request");
        }
        return asyncResponse(existing, requestedStage, owner, true);
      }
      const reusable = await requests.findReusableNavigation({
        owner,
        domainId: resolved.domain.domain_id,
        discoveryCompatibilityHash
      });
      if (reusable) return asyncResponse(reusable, requestedStage, owner, true);

      const created = await requests.create({
        idempotencyKey,
        owner,
        domainId: resolved.domain.domain_id,
        startingEntityPathId: resolved.path.entity_path_id,
        categorySelectionMode: "all",
        promptDepth: "weak",
        source: "manual",
        requestPayload,
        canonicalRequestHash,
        discoveryCompatibilityHash
      });
      if (!created) throw new Error("Hierarchy navigation request could not be created");
      await categories.createOrReuseForRequest(created.pre_analysis_request_id, categoryIds);
      await new OutboxEventWriterRepository(client).create({
        eventKey: `pre_analysis_request.accepted:${created.pre_analysis_request_id}`,
        eventType: "pre_analysis_request.accepted",
        eventVersion: 1,
        aggregateType: "pre_analysis_request",
        aggregateId: created.pre_analysis_request_id,
        headers: { queueName: "domain_hierarchy_discovery_queue" },
        payload: { preAnalysisRequestId: created.pre_analysis_request_id }
      });
      return asyncResponse(created, requestedStage, owner, false);
    });
  }
}

export async function listImmediateChildren(
  database: DatabaseExecutor,
  parent: {
    normalizedDomain: string;
    domainId: string;
    categoryId: string | null;
    brandId: string | null;
    productId: string | null;
    pathType: EntityPathType;
  },
  actorType: OwnershipContext["actorType"]
): Promise<HierarchyChild[]> {
  if (parent.pathType === "use_context") return [];
  const result = parent.pathType === "domain"
    ? await database.query<{ id: string; name: string }>(
        `SELECT c.category_id AS id,c.category_name AS name
         FROM domain_categories dc JOIN categories c ON c.category_id=dc.category_id AND c.is_active
         WHERE dc.domain_id=$1 AND dc.is_active
         ORDER BY dc.discovery_rank NULLS LAST,dc.sort_order NULLS LAST,c.normalized_name,dc.domain_category_id`,
        [parent.domainId]
      )
    : parent.pathType === "category"
      ? await database.query<{ id: string; name: string }>(
          `SELECT b.brand_id AS id,b.brand_name AS name
           FROM domain_categories dc JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active
           JOIN brands b ON b.brand_id=cb.brand_id AND b.is_active
           WHERE dc.domain_id=$1 AND dc.category_id=$2 AND dc.is_active
           ORDER BY cb.sort_order NULLS LAST,b.normalized_name,cb.category_brand_id`,
          [parent.domainId, parent.categoryId]
        )
      : parent.pathType === "brand"
        ? await database.query<{ id: string; name: string }>(
            `SELECT p.product_id AS id,p.product_name AS name
             FROM domain_categories dc JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active
             JOIN brand_products bp ON bp.category_brand_id=cb.category_brand_id AND bp.is_active
             JOIN products p ON p.product_id=bp.product_id AND p.is_active
             WHERE dc.domain_id=$1 AND dc.category_id=$2 AND cb.brand_id=$3 AND dc.is_active
             ORDER BY bp.sort_order NULLS LAST,p.normalized_name,bp.brand_product_id`,
            [parent.domainId, parent.categoryId, parent.brandId]
          )
        : await database.query<{ id: string; name: string }>(
            `SELECT uc.use_context_id AS id,uc.use_context_name AS name
             FROM domain_categories dc JOIN category_brands cb ON cb.domain_category_id=dc.domain_category_id AND cb.is_active
             JOIN brand_products bp ON bp.category_brand_id=cb.category_brand_id AND bp.is_active
             JOIN product_use_contexts puc ON puc.brand_product_id=bp.brand_product_id AND puc.is_active
             JOIN use_contexts uc ON uc.use_context_id=puc.use_context_id AND uc.is_active
             WHERE dc.domain_id=$1 AND dc.category_id=$2 AND cb.brand_id=$3 AND bp.product_id=$4 AND dc.is_active
             ORDER BY puc.sort_order NULLS LAST,uc.normalized_name,puc.product_use_context_id`,
            [parent.domainId, parent.categoryId, parent.brandId, parent.productId]
          );
  const childType = nextStage(parent.pathType) as Exclude<EntityPathType, "domain">;
  return result.rows.map((row) => ({
    entityType: childType,
    entityId: row.id,
    name: row.name,
    path: {
      domain: parent.normalizedDomain,
      categoryId: childType === "category" ? row.id : parent.categoryId,
      brandId: childType === "brand" ? row.id : parent.brandId,
      productId: childType === "product" ? row.id : parent.productId,
      useContextId: childType === "use_context" ? row.id : null
    },
    canAnalyze: true,
    canContinue: childType !== "use_context" && !(actorType === "anonymous" && childType === "brand")
  }));
}

export function navigationStatus(request: PreAnalysisRequestRow) {
  if (request.status === "paused_budget") return "paused_budget";
  if (request.status === "failed" || request.status === "cancelled") return "failed";
  if (request.status === "completed_without_analysis") {
    if (request.discovery_status === "completed_empty") return "completed_empty";
    if (request.discovery_status === "partial_success") return "partial";
    return "completed";
  }
  return "pending";
}

function nextStage(pathType: EntityPathType): HierarchyDiscoveryStage | null {
  if (pathType === "domain") return "category";
  if (pathType === "category") return "brand";
  if (pathType === "brand") return "product";
  if (pathType === "product") return "use_context";
  return null;
}

function databaseResponse(stage: HierarchyDiscoveryStage, children: HierarchyChild[], owner: OwnershipContext) {
  return {
    source: "database" as const,
    requestedStage: stage,
    status: "completed" as const,
    preAnalysisRequestId: null,
    children,
    selectionLimit: owner.actorType === "anonymous"
      ? ANONYMOUS_HIERARCHY_BREADTH
      : AUTHENTICATED_HIERARCHY_BREADTH
  };
}

function asyncResponse(request: PreAnalysisRequestRow, stage: HierarchyDiscoveryStage, owner: OwnershipContext, idempotentReplay: boolean) {
  return {
    source: "discovery" as const,
    requestedStage: stage,
    status: navigationStatus(request),
    preAnalysisRequestId: request.pre_analysis_request_id,
    children: [] as HierarchyChild[],
    selectionLimit: owner.actorType === "anonymous"
      ? ANONYMOUS_HIERARCHY_BREADTH
      : AUTHENTICATED_HIERARCHY_BREADTH,
    idempotentReplay
  };
}

function ownerScopedIdempotencyKey(owner: OwnershipContext, clientKey: string) {
  return owner.actorType === "anonymous"
    ? `anonymous:${owner.anonymousSessionId}:${clientKey}`
    : `user:${owner.userId}:${owner.workspaceId}:${clientKey}`;
}
