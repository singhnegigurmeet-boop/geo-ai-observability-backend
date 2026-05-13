import { TopKValue } from "../config/constants.js";

export function buildRankingPrompt(domain: string) {
  return `Analyze this domain: ${domain}

You are a GEO and AI search visibility analyst.

Task:

1. Identify the primary category or industry this domain belongs to.
2. Estimate this domain's AI search visibility ranking within its category.
3. Return a numeric rank only if the domain appears sufficiently known or competitive in that category.
4. If visibility confidence is low or the domain is unknown, return null for rank.

Return ONLY valid JSON in this exact format:

{
"category": "string",
"rank": 1,
"confidence": "high",
"reason": "short explanation"
}

Rules:

* category must be short and specific.
* rank must be a positive integer or null.
* confidence must be one of:

  * high
  * medium
  * low
* If the domain is unknown or visibility is unclear:

  * rank must be null
  * confidence should be low
* Keep reason under 30 words.
* Do not include markdown.
* Do not include extra text.
* Return valid JSON only.`;
}

export function buildObservabilityPrompt(domain: string) {
  return `You are analyzing this domain for Generative Engine Optimization visibility:

Domain: ${domain}

Give a detailed natural-language analysis covering:

1. What category this domain belongs to
2. Why AI systems may or may not recommend it
3. Its likely competitors in the same category
4. Its strengths from an AI visibility perspective
5. Its weaknesses or visibility gaps
6. What kind of user prompts may surface this domain

Do NOT return JSON.
Return a clear full-text analysis.`;
}

export function buildScoringPrompt(domain: string, topK: TopKValue) {
  return `You are a GEO and AI search visibility evaluator.

Domain: ${domain}
Top K: ${topK}

Task:
Generate the top ${topK} brands/products/platforms in the relevant category for this domain.

Check whether the given domain/brand appears in that top ${topK} list.

Return ONLY valid JSON in this exact format:

{
  "top_k": ${topK},
  "brand_found": true,
  "rank_position": 4,
  "mention_count": 2,
  "score": 85,
  "category": "string",
  "reason": "short explanation"
}

Rules:
- top_k must match the requested value.
- brand_found must be true or false.
- rank_position must be a number if found, otherwise null.
- mention_count means how many times the brand/domain appears in the generated answer.
- score must be between 0 and 100.
- If brand is found in top 5, score should be very high.
- If brand is found in top 10, score should be high.
- If brand is found in top 15, score should be medium.
- If brand is found in top 50, score should be low-medium.
- If brand is found in top 100, score should be low.
- If brand is not found, score must be 0.
- Do not include markdown.
- Do not include extra text.`;
}