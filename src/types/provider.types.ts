import { ProviderName, TopKValue } from "../config/constants.js";

export type RankingResult = {
  category: string;
  rank: number | null;
  reason: string;
  rawResponse: string;
};

export type ScoringResult = {
  topK: TopKValue;
  brandFound: boolean;
  rankPosition: number | null;
  mentionCount: number;
  score: number;
  category: string;
  reason: string;
  rawResponse: string;
};

export type ProviderExecutionResult = {
  llmName: ProviderName;
  ranking: RankingResult;
  observabilityResponse: string;
  scoring: ScoringResult[];
};

export interface ProviderAdapter {
  readonly name: ProviderName;
  runTextPrompt(prompt: string): Promise<string>;
}
