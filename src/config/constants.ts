export const PROVIDERS = ["openai", "gemini", "claude"] as const;
export const TOP_K_VALUES = [5, 10, 15, 50, 100] as const;
export const PROVIDER_STATUSES = ["processing", "completed", "failed"] as const;

export type ProviderName = (typeof PROVIDERS)[number];
export type TopKValue = (typeof TOP_K_VALUES)[number];
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];
