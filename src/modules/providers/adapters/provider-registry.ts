import { PROVIDERS } from "../../../config/constants.js";
import { env } from "../../../config/env.js";
import { AnthropicProviderAdapter } from "./anthropic-provider-adapter.js";
import { GeminiProviderAdapter } from "./gemini-provider-adapter.js";
import { MockProviderAdapter } from "./mock-provider-adapter.js";
import { OpenAIProviderAdapter } from "./openai-provider-adapter.js";
import { ProviderAdapter } from "../../../types/provider.types.js";
import { UnavailableProviderAdapter } from "./unavailable-provider-adapter.js";

export const providerAdapters: ProviderAdapter[] = env.USE_MOCK_PROVIDERS
  ? PROVIDERS.map((provider) => new MockProviderAdapter(provider))
  : [
      env.OPENAI_API_KEY
        ? new OpenAIProviderAdapter()
        : new UnavailableProviderAdapter("openai", "OPENAI_API_KEY is not configured"),
      env.GEMINI_API_KEY
        ? new GeminiProviderAdapter()
        : new UnavailableProviderAdapter("gemini", "GEMINI_API_KEY is not configured"),
      env.ANTHROPIC_API_KEY
        ? new AnthropicProviderAdapter()
        : new UnavailableProviderAdapter("claude", "ANTHROPIC_API_KEY is not configured")
    ];
