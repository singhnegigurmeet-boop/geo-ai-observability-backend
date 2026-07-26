import { createHash } from "node:crypto";
import type { ProviderName } from "../../../common/types/database.types.js";

export type ClassificationExecutionIdentity = {
  analysisRunId: string;
  domainId: string;
  candidateSetHash: string;
  classifierProvider: ProviderName;
  classifierModel: string;
  modelProfileVersion: string;
  promptVersion: string;
  responseContractVersion: string;
  providerInstructionProfile: string;
  structuredOutputMode: string;
};

export function classificationCandidateSetHash(
  orderedCategoryIds: readonly string[]
) {
  return sha256(
    JSON.stringify(
      orderedCategoryIds.map((categoryId) => normalize(categoryId))
    )
  );
}

export function canonicalClassificationExecutionIdentity(
  identity: ClassificationExecutionIdentity
) {
  return JSON.stringify([
    "classification",
    normalize(identity.analysisRunId),
    normalize(identity.domainId),
    normalize(identity.candidateSetHash),
    normalize(identity.classifierProvider),
    normalize(identity.classifierModel),
    normalize(identity.modelProfileVersion),
    normalize(identity.promptVersion),
    normalize(identity.responseContractVersion),
    normalize(identity.providerInstructionProfile),
    normalize(identity.structuredOutputMode)
  ]);
}

export function classificationExecutionHash(
  identity: ClassificationExecutionIdentity
) {
  return sha256(canonicalClassificationExecutionIdentity(identity));
}

export function classificationIdempotencyKey(
  identity: ClassificationExecutionIdentity
) {
  return `classification:${classificationExecutionHash(identity)}`;
}

function normalize(value: string) {
  return value.trim();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
