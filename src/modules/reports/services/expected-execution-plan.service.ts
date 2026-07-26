import type {
  AnalysisExecutionStatus,
  EntityPathType,
  PromptDepth,
  PromptType,
  ProviderName
} from "../../../common/types/database.types.js";
import {
  applicablePromptTypesForPolicy,
  requiresScoring
} from "../../prompts/policies/prompt-policy.registry.js";

export type ExpectedPlanRun = {
  analysisRunId: string;
  status: AnalysisExecutionStatus;
  promptDepth: PromptDepth;
  promptPolicyVersion: string;
};

export type ExpectedPlanItem = {
  analysisRunItemId: string;
  entityPathId: string;
  targetLevel: EntityPathType;
  categoryId: string | null;
  categoryName: string | null;
  itemOrdinal: number;
  status: AnalysisExecutionStatus;
};

export type ExpectedPlanProviderModel = {
  provider: ProviderName;
  model: string;
  modelProfileVersion: string;
  ordinal: number;
};

export type ExpectedProviderExecution = {
  analysisRunId: string;
  analysisRunItemId: string;
  entityPathId: string;
  targetLevel: EntityPathType;
  categoryId: string | null;
  categoryName: string | null;
  itemOrdinal: number;
  promptType: PromptType;
  promptOrdinal: number;
  promptDepth: PromptDepth;
  promptPolicyVersion: string;
  provider: ProviderName;
  model: string;
  modelProfileVersion: string;
  modelOrdinal: number;
  requiresScoring: boolean;
  identity: string;
};

export function buildExpectedProviderExecutionPlan(input: {
  run: ExpectedPlanRun;
  items: readonly ExpectedPlanItem[];
  providerModels: readonly ExpectedPlanProviderModel[];
}): ExpectedProviderExecution[] {
  const models = uniqueProviderModels(input.providerModels);
  const expected: ExpectedProviderExecution[] = [];
  const identities = new Set<string>();

  for (const item of [...input.items].sort(compareItems)) {
    const promptTypes = applicablePromptTypesForPolicy(
      input.run.promptPolicyVersion,
      item.targetLevel
    );
    for (const [promptOrdinal, promptType] of promptTypes.entries()) {
      for (const model of models) {
        const identity = expectedExecutionIdentity(
          item.analysisRunItemId,
          promptType,
          model.provider,
          model.model
        );
        if (identities.has(identity)) continue;
        identities.add(identity);
        expected.push({
          analysisRunId: input.run.analysisRunId,
          analysisRunItemId: item.analysisRunItemId,
          entityPathId: item.entityPathId,
          targetLevel: item.targetLevel,
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          itemOrdinal: item.itemOrdinal,
          promptType,
          promptOrdinal,
          promptDepth: input.run.promptDepth,
          promptPolicyVersion: input.run.promptPolicyVersion,
          provider: model.provider,
          model: model.model,
          modelProfileVersion: model.modelProfileVersion,
          modelOrdinal: model.ordinal,
          requiresScoring: requiresScoring(promptType),
          identity
        });
      }
    }
  }
  return expected;
}

export function expectedExecutionIdentity(
  analysisRunItemId: string,
  promptType: PromptType,
  provider: ProviderName,
  model: string
) {
  return [analysisRunItemId, promptType, provider, model].join("\u0000");
}

function uniqueProviderModels(
  models: readonly ExpectedPlanProviderModel[]
) {
  const unique = new Map<string, ExpectedPlanProviderModel>();
  for (const model of [...models].sort(compareModels)) {
    const identity = `${model.provider}\u0000${model.model}`;
    unique.set(identity, unique.get(identity) ?? model);
  }
  return [...unique.values()];
}

function compareItems(left: ExpectedPlanItem, right: ExpectedPlanItem) {
  return (
    left.itemOrdinal - right.itemOrdinal ||
    compareDatabaseIds(left.analysisRunItemId, right.analysisRunItemId)
  );
}

function compareModels(
  left: ExpectedPlanProviderModel,
  right: ExpectedPlanProviderModel
) {
  return (
    left.ordinal - right.ordinal ||
    left.provider.localeCompare(right.provider) ||
    left.model.localeCompare(right.model)
  );
}

function compareDatabaseIds(left: string, right: string) {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
