import type {
  ScoreCalculation,
  ScoreCalculationInput
} from "../modules/scoring/types/score.types.js";

export function calculateProviderScore(
  input: ScoreCalculationInput
): ScoreCalculation {
  const result = input.validatedResponse.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Validated provider response has no result object");
  }
  if (input.promptType === "visibility") {
    const mention = clamp(result.mention_likelihood as number);
    const recommendation = clamp(
      result.recommendation_likelihood as number
    );
    const prominence = clamp(result.competitive_prominence as number);
    return {
      metricType: "visibility",
      score: round(
        100 *
          (0.45 * mention + 0.35 * recommendation + 0.2 * prominence)
      ),
      components: {
        metric: "visibility",
        mention_likelihood: mention,
        recommendation_likelihood: recommendation,
        competitive_prominence: prominence,
        confidence: result.confidence as number,
        weights: {
          mention: 0.45,
          recommendation: 0.35,
          prominence: 0.2
        }
      }
    };
  }
  if (input.promptType === "ranking") {
    const found = result.found as boolean;
    const topK = result.requested_top_k as number;
    const rankPosition = result.rank_position as number | null;
    const score =
      found && rankPosition !== null
        ? (100 * (topK - rankPosition + 1)) / topK
        : 0;
    return {
      metricType: "ranking",
      score: round(score),
      components: {
        metric: "ranking",
        found,
        requested_top_k: topK,
        rank_position: rankPosition,
        confidence: result.confidence as number,
        formula: found
          ? "100 * (top_k - rank_position + 1) / top_k"
          : "valid negative evidence = 0"
      }
    };
  }
  throw new Error(`${input.promptType} is diagnostic and not GEO-scorable`);
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
