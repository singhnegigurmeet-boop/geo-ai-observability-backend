import { ProviderName } from "../config/constants.js";
import { ProviderAdapter } from "../types/provider.types.js";

export class MockProviderAdapter implements ProviderAdapter {
  constructor(readonly name: ProviderName) {}

  async runTextPrompt(prompt: string): Promise<string> {
    const domain = extractDomain(prompt);
    const topK = extractTopK(prompt);
    const profile = buildDomainProfile(domain, this.name);

    if (topK) {
      const found = profile.rank <= topK;
      return JSON.stringify({
        top_k: topK,
        brand_found: found,
        rank_position: found ? profile.rank : null,
        mention_count: found ? profile.mentionCount : 0,
        score: found ? scoreForRank(profile.rank, topK) : 0,
        category: profile.category,
        reason: found
          ? `${domain} appears within the mock ${this.name} top ${topK} set.`
          : `${domain} does not appear within the mock ${this.name} top ${topK} set.`
      });
    }

    if (prompt.includes("Return ONLY valid JSON")) {
      return JSON.stringify({
        category: profile.category,
        rank: profile.rank,
        reason: `${domain} has a deterministic mock visibility rank for local pipeline testing.`
      });
    }

    return [
      `${domain} belongs to the ${profile.category} category.`,
      `Mock ${this.name} analysis says it may be recommended when users ask for recognizable options in this space.`,
      "Likely competitors depend on the category and should be resolved by the real provider adapter later.",
      "Strengths include clear domain recognition and repeated category association.",
      "Weaknesses include unknown real-world citation support in this mock mode.",
      `Prompts mentioning ${profile.category} comparisons may surface this domain.`
    ].join(" ");
  }
}

function extractDomain(prompt: string) {
  const domainLine = prompt.match(/Domain:\s*([^\n]+)/i);
  const analyzeLine = prompt.match(/Analyze this domain:\s*([^\n]+)/i);
  return (domainLine?.[1] ?? analyzeLine?.[1] ?? "example.com").trim().toLowerCase();
}

function extractTopK(prompt: string) {
  const match = prompt.match(/Top K:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function buildDomainProfile(domain: string, provider: ProviderName) {
  const hash = stableHash(`${provider}:${domain}`);
  const categories = ["commerce", "software", "media", "finance", "education"];

  return {
    category: categories[hash % categories.length],
    rank: (hash % 75) + 1,
    mentionCount: (hash % 3) + 1
  };
}

function stableHash(value: string) {
  let hash = 0;

  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash;
}

function scoreForRank(rank: number, topK: number) {
  if (rank <= 5) return 95;
  if (rank <= 10) return 85;
  if (rank <= 15) return 65;
  if (rank <= 50) return Math.max(30, 60 - Math.floor(rank / 2));
  if (rank <= 100) return Math.max(10, 35 - Math.floor(rank / 4));
  return Math.max(0, 100 - Math.floor((rank / topK) * 100));
}
