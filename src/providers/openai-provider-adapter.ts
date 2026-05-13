import { env } from "../config/env.js";
import { ProviderAdapter } from "../types/provider.types.js";
import { postJson, requireText } from "./http.js";

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

export class OpenAIProviderAdapter implements ProviderAdapter {
  readonly name = "openai";

  async runTextPrompt(prompt: string) {
    const response = await postJson<OpenAIResponse>(
      "https://api.openai.com/v1/responses",
      {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      {
        model: env.OPENAI_MODEL,
        input: prompt,
        temperature: 0.2
      },
      "openai"
    );

    return requireText(response.output_text ?? extractOutputText(response), "openai");
  }
}

function extractOutputText(response: OpenAIResponse) {
  return response.output
    ?.flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text" || content.text)
    .map((content) => content.text)
    .filter(Boolean)
    .join("\n");
}
