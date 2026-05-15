import { env } from "../../../config/env.js";
import { ProviderAdapter } from "../../../types/provider.types.js";
import { postJson, requireText } from "./http.js";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

export class GeminiProviderAdapter implements ProviderAdapter {
  readonly name = "gemini";

  async runTextPrompt(prompt: string) {
    const response = await postJson<GeminiResponse>(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
      {
        "x-goog-api-key": env.GEMINI_API_KEY ?? ""
      },
      {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.2
        }
      },
      "gemini"
    );

    const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text).filter(Boolean).join("\n");
    return requireText(text, "gemini");
  }
}
