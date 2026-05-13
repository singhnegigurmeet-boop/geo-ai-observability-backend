import { env } from "../config/env.js";
import { ProviderAdapter } from "../types/provider.types.js";
import { postJson, requireText } from "./http.js";

type AnthropicResponse = {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

export class AnthropicProviderAdapter implements ProviderAdapter {
  readonly name = "claude";

  async runTextPrompt(prompt: string) {
    const response = await postJson<AnthropicResponse>(
      "https://api.anthropic.com/v1/messages",
      {
        "x-api-key": env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01"
      },
      {
        model: env.ANTHROPIC_MODEL,
        max_tokens: 2048,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      },
      "claude"
    );

    const text = response.content
      ?.filter((content) => content.type === "text" || content.text)
      .map((content) => content.text)
      .filter(Boolean)
      .join("\n");

    return requireText(text, "claude");
  }
}
