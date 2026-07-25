import type { JsonValue, PromptType } from "../types/database.types.js";
import type {
  ScoreCalculation,
  ScoreCalculationInput
} from "./score.types.js";

const promptTypeBaselines: Record<PromptType, number> = {
  visibility: 70,
  competitor: 60,
  ranking: 65,
  price_range: 55,
  pros_cons: 75
};

export function calculateProviderScore(
  input: ScoreCalculationInput
): ScoreCalculation {
  const evidence = asArray(input.parsedResponse.evidence);
  const confidences = evidence
    .map((entry) => confidenceFrom(entry))
    .filter((value): value is number => value !== null);
  const evidenceConfidence =
    confidences.length > 0
      ? confidences.reduce((total, value) => total + value, 0) /
        confidences.length
      : 0;
  const baseline = promptTypeBaselines[input.promptType];
  const score = roundScore(baseline * 0.7 + evidenceConfidence * 100 * 0.3);

  return {
    score,
    components: {
      scoreType: `${input.promptType}_score`,
      scoringVersion: "backend-v1",
      promptType: input.promptType,
      promptVersion: input.promptVersion,
      provider: input.provider,
      model: input.model,
      baseline,
      evidenceCount: evidence.length,
      evidenceConfidence: roundScore(evidenceConfidence),
      formula: "70% prompt baseline + 30% mean evidence confidence"
    }
  };
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function confidenceFrom(value: JsonValue): number | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence)
  ) {
    return null;
  }
  return Math.min(1, Math.max(0, value.confidence));
}

function roundScore(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
