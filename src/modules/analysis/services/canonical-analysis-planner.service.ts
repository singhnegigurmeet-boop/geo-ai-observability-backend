import { createHash } from "node:crypto";
import type { DatabaseExecutor } from "../../../common/database/database-executor.js";
import { ApplicationError } from "../../../common/errors/application-error.js";
import type { OwnershipContext } from "../../../common/ownership/ownership-context.types.js";
import type { EntityPathRow, EntityPathType, JsonObject, PromptDepth } from "../../../common/types/database.types.js";
import { TokenEstimatorService } from "../../budgets/services/token-estimator.service.js";
import { HierarchyService } from "../../hierarchy/services/hierarchy.service.js";
import { applicablePromptTypes, InvalidPromptDepthError, PROMPT_POLICY_VERSION, promptTypePolicy, resolvePromptDepth } from "../../prompts/policies/prompt-policy.registry.js";
import { InvalidProviderModelSelectionError, resolveProviderModelSet } from "../../providers/policies/provider-model.policy.js";
import { AnalysisRunExpansionRepository } from "../repositories/analysis-run-expansion.repository.js";
import { AnalysisRunRequestedCategoryRepository, InactiveRequestedCategoryError } from "../repositories/analysis-run-requested-category.repository.js";
import type { CreateAnalysisRequest } from "../schemas/analysis.schemas.js";
import type { CanonicalAnalysisPlan, CanonicalAnalysisRequest, PlanningEstimateRange } from "../types/analysis.types.js";

export const ANALYSIS_PLANNER_VERSION = "canonical-analysis-planner-v2";
export const MAX_ESTIMATED_PROVIDER_JOBS = 5_000;
export const MAX_ESTIMATED_TOTAL_TOKENS = 20_000_000;
export const MAX_ESTIMATED_COST_MICROS = 1_000_000_000_000;

export class CanonicalAnalysisPlannerService {
  constructor(
    private readonly database: DatabaseExecutor,
    private readonly hierarchy = new HierarchyService(),
    private readonly realProvidersEnabled = false
  ) {}

  async plan(request: CreateAnalysisRequest, owner: OwnershipContext, options: { frozenCategoryIds?: string[] } = {}): Promise<CanonicalAnalysisPlan> {
    const selection = request.categorySelection ?? { mode: "all" as const };
    let promptDepth: PromptDepth;
    try { promptDepth = resolvePromptDepth(owner.actorType, request.promptDepth); }
    catch (error) { if (error instanceof InvalidPromptDepthError) throw new ApplicationError("VALIDATION_ERROR", error.message); throw error; }
    let providerModels;
    try {
      providerModels = resolveProviderModelSet({ actorType: owner.actorType, providerModels: request.providerModels ?? null, promptDepth, realProvidersEnabled: this.realProvidersEnabled });
    } catch (error) { if (error instanceof InvalidProviderModelSelectionError) throw new ApplicationError("VALIDATION_ERROR", error.message); throw error; }
    const categories = new AnalysisRunRequestedCategoryRepository(this.database);
    let frozenCategories;
    try {
      frozenCategories = await categories.resolveActive(options.frozenCategoryIds ? { mode: "selected", categoryIds: options.frozenCategoryIds } : selection);
    } catch (error) { if (error instanceof InactiveRequestedCategoryError) throw new ApplicationError("VALIDATION_ERROR", error.message); throw error; }
    if (frozenCategories.length === 0) throw new ApplicationError("VALIDATION_ERROR", "Category selection resolved to no active categories");

    const startingSelection = { domain: request.domain, categoryId: request.categoryId ?? null, brandId: request.brandId ?? null, productId: request.productId ?? null, useContextId: request.useContextId ?? null };
    const validated = await this.hierarchy.validateStartingPath(this.database, startingSelection);
    if (!validated.domain || !validated.path) throw new ApplicationError("CONFLICT", "Hierarchy discovery must complete before canonical analysis planning");
    const breadth = owner.actorType === "anonymous" ? 3 : 5;
    const plannedEntityPaths = await knownTargets(this.database, validated.path, frozenCategories.map((row) => row.category_id), breadth);
    if (plannedEntityPaths.length === 0) throw new ApplicationError("CONFLICT", "No hierarchy-ready analysis target exists");
    const targetLevel = targetLevelFor(validated.path.path_type);
    const promptTypes = applicablePromptTypes(targetLevel);
    const pathRange = exactRange(plannedEntityPaths.length);
    const promptRange = multiplyRange(pathRange, promptTypes.length);
    const jobRange = multiplyRange(promptRange, providerModels.length);
    const estimator = new TokenEstimatorService();
    const byProviderModel = providerModels.map((model) => {
      let inputTokens = 0, outputTokens = 0, costMicros = 0;
      for (const promptType of promptTypes) {
        const policy = promptTypePolicy(promptType);
        const estimate = estimator.estimate({ provider: model.provider, model: model.model, promptText: `${policy.businessPromptVersion}\n${validated.normalizedDomain}`, promptType, promptDepth });
        inputTokens += estimate.inputTokens; outputTokens += estimate.outputTokens; costMicros += estimate.costMicros;
      }
      return { provider: model.provider, model: model.model, modelProfileVersion: model.modelProfileVersion, executionCount: multiplyRange(pathRange, promptTypes.length), tokens: { input: exactRange(inputTokens * plannedEntityPaths.length), output: exactRange(outputTokens * plannedEntityPaths.length), total: exactRange((inputTokens + outputTokens) * plannedEntityPaths.length) }, costMicros: exactRange(costMicros * plannedEntityPaths.length) };
    });
    const totalTokens = byProviderModel.reduce((sum, row) => sum + row.tokens.total.maximum, 0);
    const totalCost = byProviderModel.reduce((sum, row) => sum + row.costMicros.maximum, 0);
    const safetyLimits = { maximumProviderJobs: MAX_ESTIMATED_PROVIDER_JOBS, maximumTotalTokens: MAX_ESTIMATED_TOTAL_TOKENS, maximumCostMicros: MAX_ESTIMATED_COST_MICROS, providerJobsWithinLimit: jobRange.maximum <= MAX_ESTIMATED_PROVIDER_JOBS, tokensWithinLimit: totalTokens <= MAX_ESTIMATED_TOTAL_TOKENS, costWithinLimit: totalCost <= MAX_ESTIMATED_COST_MICROS, accepted: false };
    safetyLimits.accepted = safetyLimits.providerJobsWithinLimit && safetyLimits.tokensWithinLimit && safetyLimits.costWithinLimit;
    if (!safetyLimits.accepted) throw new ApplicationError("VALIDATION_ERROR", "Analysis planning estimate exceeds the supported safety limits");
    const ownershipScope: JsonObject = owner.actorType === "anonymous" ? { actorType: owner.actorType, anonymousSessionId: owner.anonymousSessionId } : { actorType: owner.actorType, userId: owner.userId, workspaceId: owner.workspaceId };
    const canonicalIdentity = { plannerVersion: ANALYSIS_PLANNER_VERSION, ownershipScope, domain: validated.normalizedDomain, categoryId: startingSelection.categoryId, brandId: startingSelection.brandId, productId: startingSelection.productId, useContextId: startingSelection.useContextId, categorySelection: { mode: selection.mode, categoryIds: frozenCategories.map((row) => row.category_id) }, promptDepth, promptPolicyVersion: PROMPT_POLICY_VERSION, providerModels: providerModels.map((model) => ({ provider: model.provider, model: model.model, modelProfileVersion: model.modelProfileVersion, providerInstructionProfile: model.providerInstructionProfile, structuredOutputMode: model.preferredStructuredOutputMode })) } satisfies JsonObject;
    const canonicalRequestHash = hashCanonical(canonicalIdentity);
    const canonicalRequestPayload: CanonicalAnalysisRequest = { ...canonicalIdentity, canonicalPlannerVersion: ANALYSIS_PLANNER_VERSION, canonicalRequestHash, planningEstimate: { selectedPathCount: pathRange, applicablePromptCount: promptRange, normalProviderJobCount: jobRange, totalProviderJobCount: jobRange, tokenEstimate: exactRange(totalTokens), costEstimateMicros: exactRange(totalCost), currency: "USD", pricingProfile: "provider-model-registry-v1", boundedPlanningEstimate: true } };
    return { normalizedDomain: validated.normalizedDomain, frozenCategorySelection: canonicalIdentity.categorySelection, frozenRequestedCategoryCount: frozenCategories.length, hierarchyReady: true, discoveryRequired: false, estimatedEligibleCategories: pathRange, plannedEntityPaths, applicablePromptsByPath: [...promptTypes], applicablePromptCountEstimate: promptRange, resolvedProviderModels: providerModels, expectedExecutions: { normalProviderJobCountEstimate: jobRange, totalProviderJobCountEstimate: jobRange }, promptDepth, promptPolicyVersion: PROMPT_POLICY_VERSION, tokenEstimate: exactRange(totalTokens), costEstimate: { ...exactRange(totalCost), currency: "USD", pricingProfile: "provider-model-registry-v1" }, normalAnalysisEstimate: { tokens: exactRange(totalTokens), costMicros: exactRange(totalCost) }, byProviderModel, safetyLimits, canonicalRequestPayload, canonicalRequestHash };
  }
}

async function knownTargets(database: DatabaseExecutor, path: EntityPathRow, categoryIds: string[], breadth: number) {
  const expansion = new AnalysisRunExpansionRepository(database);
  if (path.path_type === "domain") {
    const rows = await database.query<{ category_id: string }>(`SELECT category_id FROM domain_categories WHERE domain_id=$1 AND category_id=ANY($2::bigint[]) AND is_active ORDER BY discovery_rank NULLS LAST, sort_order NULLS LAST, domain_category_id LIMIT $3`, [path.domain_id, categoryIds, breadth]);
    return rows.rows.map((row) => ({ pathType: "category" as const, categoryId: row.category_id }));
  }
  if (path.path_type === "use_context") return [{ pathType: path.path_type, categoryId: path.category_id, brandId: path.brand_id, productId: path.product_id, useContextId: path.use_context_id }];
  const rows = path.path_type === "category" ? await expansion.listActiveBrandChildren(path, breadth) : path.path_type === "brand" ? await expansion.listActiveProductChildren(path, breadth) : await expansion.listActiveUseContextChildren(path, breadth);
  return rows.map((row) => ({ pathType: row.pathType, categoryId: row.categoryId, brandId: row.brandId, productId: row.productId, useContextId: row.useContextId }));
}
function targetLevelFor(pathType: EntityPathType): EntityPathType { if (pathType === "domain") return "category"; if (pathType === "category") return "brand"; if (pathType === "brand") return "product"; return "use_context"; }
function exactRange(value: number): PlanningEstimateRange { return { minimum: value, maximum: value }; }
function multiplyRange(range: PlanningEstimateRange, multiplier: number) { return { minimum: range.minimum * multiplier, maximum: range.maximum * multiplier }; }
export function hashCanonical(value: JsonObject) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
export function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`; return JSON.stringify(value); }
