import type { ProviderName } from "../../../common/types/database.types.js";
import { providerModelProfile } from "../../providers/registry/provider-model.registry.js";

export function estimateCostMicros(input: {
  provider: ProviderName;
  model: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const profile = providerModelProfile(input.provider, input.model);
  if (!profile) {
    throw new Error(
      `No pricing policy exists for ${input.provider}/${input.model}`
    );
  }
  const pricing = profile.pricingProfile;
  if (pricing.kind === "per_hundred_total_tokens") {
    const totalTokens =
      input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0);
    return Math.ceil(
      (totalTokens * pricing.microsPerHundredTokens) / 100
    );
  }
  return Math.ceil(
    (((input.inputTokens ?? 0) * pricing.inputMicrosPerMillion +
      (input.outputTokens ?? 0) * pricing.outputMicrosPerMillion) /
      1_000_000)
  );
}
