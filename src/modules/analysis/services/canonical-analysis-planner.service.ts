import { createHash } from "node:crypto";
import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import { ApplicationError } from "../../../common/errors/application-error.js";
import type { OwnershipContext } from "../../../common/ownership/ownership-context.types.js";
import type {
  EntityPathRow,
  EntityPathType,
  JsonObject,
  PromptDepth,
  PromptType,
  ProviderName
} from "../../../common/types/database.types.js";
import { TokenEstimatorService } from "../../budgets/services/token-estimator.service.js";
import { AnalysisRunExpansionRepository } from "../repositories/analysis-run-expansion.repository.js";
import {
  AnalysisRunRequestedCategoryRepository,
  InactiveRequestedCategoryError
} from "../repositories/analysis-run-requested-category.repository.js";
import type { CreateAnalysisRequest } from "../schemas/analysis.schemas.js";
import { HierarchyService } from "../../hierarchy/services/hierarchy.service.js";
import {
  InvalidPromptDepthError,
  PROMPT_POLICY_VERSION,
  applicablePromptTypes,
  promptTypePolicy,
  resolvePromptDepth
} from "../../prompts/policies/prompt-policy.registry.js";
import {
  InvalidProviderModelSelectionError,
  resolveClassificationModel,
  resolveProviderModelSet
} from "../../providers/policies/provider-model.policy.js";
import {
  DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION,
  DOMAIN_CATEGORY_CLASSIFICATION_PROMPT_VERSION
} from "../../providers/contracts/provider-response.contracts.js";
import { renderClassificationPrompt } from "./classification-planning.service.js";
import type {
  CanonicalAnalysisPlan,
  CanonicalAnalysisRequest,
  PlanningEstimateRange
} from "../types/analysis.types.js";

export const ANALYSIS_PLANNER_VERSION = "canonical-analysis-planner-v1";
export const MAX_ESTIMATED_PROVIDER_JOBS = 5_000;
export const MAX_ESTIMATED_TOTAL_TOKENS = 20_000_000;
export const MAX_ESTIMATED_COST_MICROS = 1_000_000_000_000;

type ClassifierSelection = {
  provider: ProviderName;
  model: string;
  realProvidersEnabled: boolean;
};

export class CanonicalAnalysisPlannerService {
  constructor(
    private readonly database: DatabaseExecutor,
    private readonly hierarchy = new HierarchyService(),
    private readonly realProvidersEnabled = false,
    private readonly classifier: ClassifierSelection = {
      provider: "mock",
      model: "mock-fast",
      realProvidersEnabled: false
    }
  ) {}

  async plan(
    request: CreateAnalysisRequest,
    owner: OwnershipContext,
    options: { frozenCategoryIds?: string[] } = {}
  ): Promise<CanonicalAnalysisPlan> {
    const selection = request.categorySelection ?? { mode: "all" as const };
    const promptDepth = resolveDepth(request, owner);
    const providerModels = resolveModels(
      request,
      owner,
      promptDepth,
      this.realProvidersEnabled
    );
    const categories = new AnalysisRunRequestedCategoryRepository(this.database);
    let frozenCategories;
    try {
      frozenCategories = await categories.resolveActive(
        options.frozenCategoryIds
          ? { mode: "selected", categoryIds: options.frozenCategoryIds }
          : selection
      );
    } catch (error) {
      if (error instanceof InactiveRequestedCategoryError) {
        throw new ApplicationError("VALIDATION_ERROR", error.message);
      }
      throw error;
    }
    if (frozenCategories.length === 0) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Category selection resolved to no active categories"
      );
    }

    const startingSelection = {
      domain: request.domain,
      categoryId: request.categoryId ?? null,
      brandId: request.brandId ?? null,
      productId: request.productId ?? null,
      useContextId: request.useContextId ?? null
    };
    const hierarchy = await this.hierarchy.validateStartingPath(
      this.database,
      startingSelection
    );
    const breadth = owner.actorType === "anonymous" ? 3 : 5;
    const domainOnly = hierarchy.pathType === "domain";
    const reusedCategories = domainOnly
      ? await this.reusedCategories(
          hierarchy.domain?.domain_id ?? null,
          frozenCategories.map((category) => category.category_id)
        )
      : [];
    const reusedIds = new Set(reusedCategories.map((category) => category.categoryId));
    const unresolvedCategoryIds = domainOnly
      ? frozenCategories
          .map((category) => category.category_id)
          .filter((categoryId) => !reusedIds.has(categoryId))
      : [];
    const classificationRequired = unresolvedCategoryIds.length > 0;
    const classifier = domainOnly
      ? resolveClassifier(this.classifier)
      : null;
    const knownPaths = await this.knownPlannedPaths(
      hierarchy.domain?.domain_id ?? null,
      hierarchy.path,
      hierarchy.pathType,
      startingSelection,
      reusedCategories.map((category) => category.categoryId),
      breadth
    );
    const selectedPathEstimate = pathEstimate({
      domainOnly,
      knownCount: knownPaths.length,
      unresolvedCount: unresolvedCategoryIds.length,
      breadth
    });
    const targetLevel = targetLevelFor(hierarchy.pathType);
    const promptTypes = applicablePromptTypes(targetLevel);
    const promptEstimate = multiplyRange(
      selectedPathEstimate,
      promptTypes.length
    );
    const normalJobEstimate = multiplyRange(
      promptEstimate,
      providerModels.length
    );
    const classificationJobCount = classificationRequired ? 1 : 0;
    const totalJobEstimate = addToRange(
      normalJobEstimate,
      classificationJobCount
    );

    const estimates = estimateUsage({
      normalizedDomain: hierarchy.normalizedDomain,
      promptDepth,
      promptTypes,
      pathEstimate: selectedPathEstimate,
      providerModels,
      classificationRequired,
      classifier,
      candidates: frozenCategories.map((category) => ({
        categoryId: category.category_id,
        categoryName: category.category_name
      }))
    });
    const safetyLimits = {
      maximumProviderJobs: MAX_ESTIMATED_PROVIDER_JOBS,
      maximumTotalTokens: MAX_ESTIMATED_TOTAL_TOKENS,
      maximumCostMicros: MAX_ESTIMATED_COST_MICROS,
      providerJobsWithinLimit:
        totalJobEstimate.maximum <= MAX_ESTIMATED_PROVIDER_JOBS,
      tokensWithinLimit:
        estimates.total.tokens.total.maximum <= MAX_ESTIMATED_TOTAL_TOKENS,
      costWithinLimit:
        estimates.total.costMicros.maximum <= MAX_ESTIMATED_COST_MICROS,
      accepted: false
    };
    safetyLimits.accepted =
      safetyLimits.providerJobsWithinLimit &&
      safetyLimits.tokensWithinLimit &&
      safetyLimits.costWithinLimit;
    if (!safetyLimits.accepted) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Analysis planning estimate exceeds the supported safety limits"
      );
    }

    const ownershipScope: JsonObject =
      owner.actorType === "anonymous"
        ? {
            actorType: owner.actorType,
            anonymousSessionId: owner.anonymousSessionId
          }
        : {
            actorType: owner.actorType,
            userId: owner.userId,
            workspaceId: owner.workspaceId
          };
    const canonicalIdentity = {
      plannerVersion: ANALYSIS_PLANNER_VERSION,
      ownershipScope,
      domain: hierarchy.normalizedDomain,
      categoryId: startingSelection.categoryId,
      brandId: startingSelection.brandId,
      productId: startingSelection.productId,
      useContextId: startingSelection.useContextId,
      categorySelection: {
        mode: selection.mode,
        categoryIds: frozenCategories.map((category) => category.category_id)
      },
      promptDepth,
      promptPolicyVersion: PROMPT_POLICY_VERSION,
      providerModels: providerModels.map((model) => ({
        provider: model.provider,
        model: model.model,
        modelProfileVersion: model.modelProfileVersion,
        providerInstructionProfile: model.providerInstructionProfile,
        structuredOutputMode: model.preferredStructuredOutputMode
      })),
      classificationProfile: classifier
        ? {
            provider: classifier.provider,
            model: classifier.model,
            modelProfileVersion: classifier.modelProfileVersion,
            promptVersion: DOMAIN_CATEGORY_CLASSIFICATION_PROMPT_VERSION,
            responseContractVersion:
              DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION,
            providerInstructionProfile: classifier.providerInstructionProfile,
            structuredOutputMode: classifier.preferredStructuredOutputMode
          }
        : null
    } satisfies JsonObject;
    const canonicalRequestHash = hashCanonical(canonicalIdentity);
    const canonicalRequestPayload: CanonicalAnalysisRequest = {
      domain: hierarchy.normalizedDomain,
      categoryId: startingSelection.categoryId,
      brandId: startingSelection.brandId,
      productId: startingSelection.productId,
      useContextId: startingSelection.useContextId,
      categorySelection: canonicalIdentity.categorySelection,
      promptDepth,
      promptPolicyVersion: PROMPT_POLICY_VERSION,
      providerModels: canonicalIdentity.providerModels,
      classificationProfile: canonicalIdentity.classificationProfile,
      canonicalPlannerVersion: ANALYSIS_PLANNER_VERSION,
      canonicalRequestHash,
      planningEstimate: {
        selectedPathCount: selectedPathEstimate,
        applicablePromptCount: promptEstimate,
        normalProviderJobCount: normalJobEstimate,
        classificationProviderJobCount: classificationJobCount,
        totalProviderJobCount: totalJobEstimate,
        tokenEstimate: estimates.total.tokens,
        costEstimateMicros: estimates.total.costMicros,
        currency: "USD",
        pricingProfile: "provider-model-registry-v1",
        boundedPlanningEstimate: true
      }
    };
    return {
      normalizedDomain: hierarchy.normalizedDomain,
      frozenCategorySelection: canonicalIdentity.categorySelection,
      frozenRequestedCategoryCount: frozenCategories.length,
      reusedCategories,
      unresolvedCategoryIds,
      classificationRequired,
      estimatedEligibleCategories: selectedPathEstimate,
      plannedEntityPaths: knownPaths,
      applicablePromptsByPath: [...promptTypes],
      applicablePromptCountEstimate: promptEstimate,
      resolvedProviderModels: providerModels,
      expectedExecutions: {
        normalProviderJobCountEstimate: normalJobEstimate,
        classificationProviderJobCount: classificationJobCount,
        totalProviderJobCountEstimate: totalJobEstimate
      },
      promptDepth,
      promptPolicyVersion: PROMPT_POLICY_VERSION,
      classificationExecutionProfile: canonicalIdentity.classificationProfile,
      tokenEstimate: estimates.total.tokens,
      costEstimate: {
        ...estimates.total.costMicros,
        currency: "USD",
        pricingProfile: "provider-model-registry-v1"
      },
      normalAnalysisEstimate: estimates.normal,
      classificationEstimate: estimates.classification,
      byProviderModel: estimates.byProviderModel,
      safetyLimits,
      canonicalRequestPayload,
      canonicalRequestHash
    };
  }

  private async reusedCategories(domainId: string | null, categoryIds: string[]) {
    if (!domainId) return [];
    const result = await this.database.query<{
      category_id: string;
      source: string;
      classification_rank: number | null;
      classification_confidence: string | null;
    }>(
      `
        SELECT relationship.category_id, relationship.source,
               relationship.classification_rank,
               relationship.classification_confidence
        FROM domain_categories AS relationship
        WHERE relationship.domain_id = $1
          AND relationship.category_id = ANY($2::bigint[])
          AND relationship.is_active
        ORDER BY relationship.classification_rank ASC NULLS LAST,
                 relationship.sort_order ASC NULLS LAST,
                 relationship.domain_category_id
      `,
      [domainId, categoryIds]
    );
    return result.rows.map((row) => ({
      categoryId: row.category_id,
      source: row.source,
      classificationRank: row.classification_rank,
      classificationConfidence:
        row.classification_confidence === null
          ? null
          : Number(row.classification_confidence)
    }));
  }

  private async knownPlannedPaths(
    domainId: string | null,
    path: EntityPathRow | null,
    pathType: EntityPathType,
    selection: {
      categoryId: string | null;
      brandId: string | null;
      productId: string | null;
      useContextId: string | null;
    },
    reusedCategoryIds: string[],
    breadth: number
  ) {
    if (pathType === "domain") {
      return reusedCategoryIds.slice(0, breadth).map((categoryId) => ({
        pathType: "category" as const,
        categoryId
      }));
    }
    if (!domainId) return [];
    const expansion = new AnalysisRunExpansionRepository(this.database);
    const effectivePath =
      path ??
      ({
        domain_id: domainId,
        category_id: selection.categoryId,
        brand_id: selection.brandId,
        product_id: selection.productId,
        use_context_id: selection.useContextId,
        path_type: pathType
      } as EntityPathRow);
    if (pathType === "use_context") {
      return [
        {
          pathType,
          categoryId: effectivePath.category_id,
          brandId: effectivePath.brand_id,
          productId: effectivePath.product_id,
          useContextId: effectivePath.use_context_id
        }
      ];
    }
    const children =
      pathType === "category"
        ? await expansion.listActiveBrandChildren(effectivePath, breadth)
        : pathType === "brand"
          ? await expansion.listActiveProductChildren(effectivePath, breadth)
          : await expansion.listActiveUseContextChildren(effectivePath, breadth);
    return children.map((child) => ({
      pathType: child.pathType,
      categoryId: child.categoryId,
      brandId: child.brandId,
      productId: child.productId,
      useContextId: child.useContextId
    }));
  }
}

function resolveDepth(request: CreateAnalysisRequest, owner: OwnershipContext) {
  try {
    return resolvePromptDepth(owner.actorType, request.promptDepth);
  } catch (error) {
    if (error instanceof InvalidPromptDepthError) {
      throw new ApplicationError("VALIDATION_ERROR", error.message);
    }
    throw error;
  }
}

function resolveModels(
  request: CreateAnalysisRequest,
  owner: OwnershipContext,
  promptDepth: PromptDepth,
  realProvidersEnabled: boolean
) {
  try {
    return resolveProviderModelSet({
      actorType: owner.actorType,
      providerModels: request.providerModels ?? null,
      promptDepth,
      realProvidersEnabled
    });
  } catch (error) {
    if (error instanceof InvalidProviderModelSelectionError) {
      throw new ApplicationError("VALIDATION_ERROR", error.message);
    }
    throw error;
  }
}

function resolveClassifier(input: ClassifierSelection) {
  try {
    return resolveClassificationModel(input);
  } catch (error) {
    if (error instanceof InvalidProviderModelSelectionError) {
      throw new ApplicationError("VALIDATION_ERROR", error.message);
    }
    throw error;
  }
}

function targetLevelFor(pathType: EntityPathType): EntityPathType {
  if (pathType === "domain") return "category";
  if (pathType === "category") return "brand";
  if (pathType === "brand") return "product";
  return "use_context";
}

function pathEstimate(input: {
  domainOnly: boolean;
  knownCount: number;
  unresolvedCount: number;
  breadth: number;
}): PlanningEstimateRange {
  if (!input.domainOnly) return exactRange(input.knownCount);
  return {
    minimum: Math.min(input.knownCount, input.breadth),
    maximum: Math.min(
      input.breadth,
      input.knownCount + input.unresolvedCount
    )
  };
}

function exactRange(value: number): PlanningEstimateRange {
  return { minimum: value, maximum: value };
}

function multiplyRange(range: PlanningEstimateRange, multiplier: number) {
  return {
    minimum: range.minimum * multiplier,
    maximum: range.maximum * multiplier
  };
}

function addToRange(range: PlanningEstimateRange, value: number) {
  return {
    minimum: range.minimum + value,
    maximum: range.maximum + value
  };
}

function estimateUsage(input: {
  normalizedDomain: string;
  promptDepth: PromptDepth;
  promptTypes: readonly PromptType[];
  pathEstimate: PlanningEstimateRange;
  providerModels: Array<{
    provider: ProviderName;
    model: string;
    modelProfileVersion: string;
  }>;
  classificationRequired: boolean;
  classifier: ReturnType<typeof resolveClassificationModel> | null;
  candidates: Array<{ categoryId: string; categoryName: string }>;
}) {
  const estimator = new TokenEstimatorService();
  const byProviderModel = input.providerModels.map((model) => {
    let perPathMinimumInput = 0;
    let perPathMaximumInput = 0;
    let perPathOutput = 0;
    let perPathMinimumCost = 0;
    let perPathMaximumCost = 0;
    for (const promptType of input.promptTypes) {
      const policy = promptTypePolicy(promptType);
      const prompt = planningPrompt(
        input.normalizedDomain,
        promptType,
        input.promptDepth,
        policy.businessPromptVersion,
        policy.responseContractVersion
      );
      const lowerEstimate = estimator.estimate({
        provider: model.provider,
        model: model.model,
        promptText: prompt,
        promptType,
        promptDepth: input.promptDepth
      });
      const upperEstimate = estimator.estimate({
        provider: model.provider,
        model: model.model,
        promptText: `${prompt}\n${"x".repeat(16_384)}`,
        promptType,
        promptDepth: input.promptDepth
      });
      perPathMinimumInput += lowerEstimate.inputTokens;
      perPathMaximumInput += upperEstimate.inputTokens;
      perPathOutput += lowerEstimate.outputTokens;
      perPathMinimumCost += lowerEstimate.costMicros;
      perPathMaximumCost += upperEstimate.costMicros;
    }
    return {
      provider: model.provider,
      model: model.model,
      modelProfileVersion: model.modelProfileVersion,
      executionCount: multiplyRange(input.pathEstimate, input.promptTypes.length),
      tokens: {
        input: scaleBounds(
          input.pathEstimate,
          perPathMinimumInput,
          perPathMaximumInput
        ),
        output: multiplyRange(input.pathEstimate, perPathOutput),
        total: scaleBounds(
          input.pathEstimate,
          perPathMinimumInput + perPathOutput,
          perPathMaximumInput + perPathOutput
        )
      },
      costMicros: scaleBounds(
        input.pathEstimate,
        perPathMinimumCost,
        perPathMaximumCost
      )
    };
  });
  const normal = sumEstimates(byProviderModel);
  let classification = {
    executionCount: 0,
    tokens: { input: exactRange(0), output: exactRange(0), total: exactRange(0) },
    costMicros: exactRange(0)
  };
  if (input.classificationRequired && input.classifier) {
    const prompt = renderClassificationPrompt({
      normalizedDomain: input.normalizedDomain,
      candidates: input.candidates,
      promptVersion: DOMAIN_CATEGORY_CLASSIFICATION_PROMPT_VERSION,
      responseContractVersion: DOMAIN_CATEGORY_CLASSIFICATION_CONTRACT_VERSION
    });
    const estimate = estimator.estimate({
      provider: input.classifier.provider,
      model: input.classifier.model,
      promptText: prompt,
      promptType: "domain_category_classification",
      promptDepth: "weak"
    });
    classification = {
      executionCount: 1,
      tokens: {
        input: exactRange(estimate.inputTokens),
        output: exactRange(estimate.outputTokens),
        total: exactRange(estimate.totalTokens)
      },
      costMicros: exactRange(estimate.costMicros)
    };
  }
  return {
    byProviderModel,
    normal,
    classification,
    total: {
      tokens: addTokenRanges(normal.tokens, classification.tokens),
      costMicros: addRanges(normal.costMicros, classification.costMicros)
    }
  };
}

function scaleBounds(
  count: PlanningEstimateRange,
  minimumPerExecution: number,
  maximumPerExecution: number
) {
  return {
    minimum: count.minimum * minimumPerExecution,
    maximum: count.maximum * maximumPerExecution
  };
}

function planningPrompt(
  domain: string,
  promptType: PromptType,
  depth: PromptDepth,
  promptVersion: string,
  contractVersion: string
) {
  return [
    "GEO planning prompt estimate",
    `domain:${domain}`,
    `promptType:${promptType}`,
    `promptDepth:${depth}`,
    `businessPromptVersion:${promptVersion}`,
    `responseContractVersion:${contractVersion}`,
    "authoritative hierarchy context and bounded response contract"
  ].join("\n");
}

function sumEstimates(
  values: Array<{
    tokens: {
      input: PlanningEstimateRange;
      output: PlanningEstimateRange;
      total: PlanningEstimateRange;
    };
    costMicros: PlanningEstimateRange;
  }>
) {
  return values.reduce(
    (total, value) => ({
      tokens: addTokenRanges(total.tokens, value.tokens),
      costMicros: addRanges(total.costMicros, value.costMicros)
    }),
    {
      tokens: {
        input: exactRange(0),
        output: exactRange(0),
        total: exactRange(0)
      },
      costMicros: exactRange(0)
    }
  );
}

function addTokenRanges(
  left: {
    input: PlanningEstimateRange;
    output: PlanningEstimateRange;
    total: PlanningEstimateRange;
  },
  right: {
    input: PlanningEstimateRange;
    output: PlanningEstimateRange;
    total: PlanningEstimateRange;
  }
) {
  return {
    input: addRanges(left.input, right.input),
    output: addRanges(left.output, right.output),
    total: addRanges(left.total, right.total)
  };
}

function addRanges(left: PlanningEstimateRange, right: PlanningEstimateRange) {
  return {
    minimum: left.minimum + right.minimum,
    maximum: left.maximum + right.maximum
  };
}

function hashCanonical(value: JsonObject) {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
