import { PROMPT_DEPTH_LIMITS } from "../policies/prompt-policy.registry.js";
import type { PromptRenderingContext } from "../types/prompt-rendering.types.js";

const TASKS = {
  visibility:
    "Measure whether and how likely the exact target is to be mentioned and recommended for relevant generative-search queries; identify strengths and visibility gaps.",
  ranking:
    "Construct an ordered comparison for the exact category scope, then report whether the exact target appears and its one-based position.",
  competitor:
    "Identify direct and indirect alternatives that overlap the exact target in the exact category or use context, and explain differentiation.",
  price_range:
    "Assess reliable public pricing for the exact target. Use unknown or not_applicable with null monetary fields when pricing cannot be supported.",
  pros_cons:
    "Assess bounded pros, cons, best-fit and poor-fit situations for the exact target within the exact comparison context."
} as const;

const RESULT_SHAPES = {
  visibility:
    '{"target_mentioned":boolean,"mention_likelihood":0..1,"recommendation_likelihood":0..1,"competitive_prominence":0..1,"query_intents":string[],"strengths":string[],"visibility_gaps":string[],"confidence":0..1}',
  ranking:
    '{"requested_top_k":integer,"found":boolean,"rank_position":integer|null,"ordered_candidates":[{"rank":integer,"name":string}],"mention_count":integer,"confidence":0..1}',
  competitor:
    '{"direct_competitors":[{"name":string,"relevance_rank":integer,"reason_for_overlap":string,"confidence":0..1}],"indirect_competitors":[same shape],"target_differentiation":string,"competitive_pressure":0..1,"confidence":0..1}',
  price_range:
    '{"applicability":"applicable"|"not_applicable"|"unknown","currency":"ISO-4217"|null,"minimum":number|null,"maximum":number|null,"pricing_basis":string,"uncertainty":string,"confidence":0..1}',
  pros_cons:
    '{"pros":string[],"cons":string[],"best_fit_for":string[],"poor_fit_for":string[],"comparison_context":string,"confidence":0..1}'
} as const;

export class PromptRendererService {
  render(context: PromptRenderingContext) {
    const limits = PROMPT_DEPTH_LIMITS[context.promptDepth];
    const path = context.entityPathContext;
    const target =
      path.useContext ??
      path.product ??
      path.brand ??
      path.category ??
      path.domain;
    const comparisonScope =
      path.useContext?.name ??
      path.category?.name ??
      "the supplied website taxonomy context";
    const depthInstruction =
      context.promptDepth === "high"
        ? "Compare direct and indirect alternatives across multiple query intents; cross-check contradictions and state uncertainty explicitly."
        : context.promptDepth === "medium"
          ? "Use balanced comparison depth, several query intents, and explain material uncertainty."
          : "Be concise but explicit; use only the strongest available evidence and state uncertainty.";

    const rendered = `You are a Generative Engine Optimization and AI-search visibility analyst.

Authoritative context (do not alter or broaden it):
- website domain: ${path.domain.name} (id ${path.domain.id})
- canonical hierarchy path: ${path.canonicalPath}
- starting level: ${path.startingLevel}
- target level: ${path.targetLevel}
- exact target: ${target.name} (id ${target.id})
- exact comparison scope: ${comparisonScope}
- prompt depth: ${context.promptDepth}

Tasks:
1. ${TASKS[context.promptType]}
2. Keep every finding bound to the exact target, website, hierarchy, category and use context above.
3. Apply this depth policy: ${depthInstruction}
4. Distinguish known evidence from inference. Lower confidence when evidence is weak, contradictory, private, unavailable or outside your knowledge.
5. Do not claim live browsing, private data, unavailable analytics, invented URLs, citations, prices, rankings or facts.
6. Use null, unknown, not_applicable, false or an empty array exactly where the response contract permits; never fabricate a value to fill a field.

Output rules:
- Return one JSON object only. No markdown, code fences, commentary or extra keys.
- prompt_type must equal "${context.promptType}".
- contract_version must equal "${context.responseContractVersion}".
- result must have exactly this shape: ${RESULT_SHAPES[context.promptType]}.
- evidence must be an array of at most ${limits.maxEvidenceItems} objects with exactly {"claim":string,"source":string,"confidence":0..1}.
- Every other result array is limited to ${limits.maxListItems} items.
- summary must be a string of at most ${limits.maxSummaryCharacters} characters.
- Ranking requested_top_k must equal ${limits.topK}; candidate ranks must be unique and contiguous from 1. If not found, found=false and rank_position=null.
- Strings must be concise, plain text, and must not contain invented citations.

Required envelope:
{"prompt_type":"${context.promptType}","contract_version":"${context.responseContractVersion}","result":${RESULT_SHAPES[context.promptType]},"evidence":[],"summary":string}`;

    if (
      context.businessPromptVersion.length === 0 ||
      context.responseContractVersion.length === 0
    ) {
      throw new UnsupportedPromptTemplateError(
        context.promptType,
        context.businessPromptVersion
      );
    }
    return rendered;
  }
}

export class UnsupportedPromptTemplateError extends Error {
  readonly code = "UNSUPPORTED_PROMPT_TEMPLATE";
  readonly permanent = true;

  constructor(promptType: string, promptVersion: string) {
    super(`Unsupported prompt template ${promptType}:${promptVersion}`);
    this.name = "UnsupportedPromptTemplateError";
  }
}
