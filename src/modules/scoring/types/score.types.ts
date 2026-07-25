import type {
  JsonObject,
  PromptType,
  ProviderName
} from "../../../common/types/database.types.js";

export const SCORING_VERSION = "backend-v1";
export const BASIC_REPORT_VERSION = "basic-v1";
export const MULTI_PROVIDER_REPORT_VERSION = "multi-provider-v2";

export type ScoreCalculationInput = {
  promptType: PromptType;
  promptVersion: string;
  provider: ProviderName;
  model: string;
  parsedResponse: JsonObject;
};

export type ScoreCalculation = {
  score: number;
  components: JsonObject;
};

export type ReportScoreRecord = {
  prompt_type: PromptType;
  score: string;
  score_components: JsonObject;
  provider: ProviderName;
  model: string;
  parsed_response: JsonObject;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: string | null;
};

export type BasicReportData = JsonObject & {
  analysisRunId: string;
  reportType: "basic_report";
  reportVersion: typeof BASIC_REPORT_VERSION;
  overallScore: number;
  summary: string;
  breakdown: Array<{
    promptType: PromptType;
    score: number;
    summary: string;
    evidenceCount: number;
  }>;
  providerModels: Array<{
    provider: ProviderName;
    model: string;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  };
};
