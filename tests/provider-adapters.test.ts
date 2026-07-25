import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeProviderAdapter } from "../src/providers/claude.provider-adapter.js";
import { GeminiProviderAdapter } from "../src/providers/gemini.provider-adapter.js";
import { OpenAiProviderAdapter } from "../src/providers/openai.provider-adapter.js";
import type {
  ProviderHttpClient,
  ProviderHttpRequest
} from "../src/providers/provider-adapter.types.js";
import { ProviderExecutionError } from "../src/providers/provider-execution.error.js";

describe("real provider adapters", () => {
  it("maps OpenAI request, response metadata, and usage", async () => {
    const http = stubHttp(200, {
      id: "chatcmpl-1",
      model: "gpt-4o-mini-2024",
      choices: [
        {
          message: { content: "OpenAI evidence", refusal: null },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    });
    const result = await new OpenAiProviderAdapter(http, "test-key").execute(
      request("openai", "gpt-4o-mini")
    );
    assert.equal(http.requests[0]?.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(http.requests[0]?.headers.authorization, "Bearer test-key");
    assert.deepEqual([result.inputTokens, result.outputTokens, result.totalTokens], [11, 7, 18]);
    assert.equal(result.providerRequestId, "chatcmpl-1");
    assert.equal(result.finishReason, "stop");
  });

  it("maps Gemini content, response metadata, and usage", async () => {
    const http = stubHttp(200, {
      responseId: "gemini-1",
      modelVersion: "gemini-1.5-flash-002",
      candidates: [
        {
          content: { parts: [{ text: "Gemini evidence" }] },
          finishReason: "STOP"
        }
      ],
      usageMetadata: {
        promptTokenCount: 9,
        candidatesTokenCount: 6,
        totalTokenCount: 15
      }
    });
    const result = await new GeminiProviderAdapter(http, "test-key").execute(
      request("gemini", "gemini-1.5-flash")
    );
    assert.match(http.requests[0]!.url, /generateContent$/);
    assert.equal(http.requests[0]?.headers["x-goog-api-key"], "test-key");
    assert.deepEqual([result.inputTokens, result.outputTokens, result.totalTokens], [9, 6, 15]);
    assert.equal(result.providerRequestId, "gemini-1");
  });

  it("maps Claude content, response metadata, and usage", async () => {
    const http = stubHttp(200, {
      id: "msg-1",
      model: "claude-3-5-sonnet",
      content: [{ type: "text", text: "Claude evidence" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 13, output_tokens: 8 }
    });
    const result = await new ClaudeProviderAdapter(http, "test-key").execute(
      request("claude", "claude-3-5-sonnet")
    );
    assert.equal(http.requests[0]?.headers["x-api-key"], "test-key");
    assert.deepEqual([result.inputTokens, result.outputTokens, result.totalTokens], [13, 8, 21]);
    assert.equal(result.providerRequestId, "msg-1");
  });

  it("stores a valid refusal as evidence and permits missing usage fallback", async () => {
    const http = stubHttp(200, {
      id: "chatcmpl-refusal",
      choices: [
        {
          message: { content: null, refusal: "I cannot answer." },
          finish_reason: "content_filter"
        }
      ]
    });
    const result = await new OpenAiProviderAdapter(http, "test-key").execute(
      request("openai", "gpt-4o-mini")
    );
    assert.equal(result.parsedEvidence.refusal, true);
    assert.equal(result.inputTokens, null);
    assert.equal(result.outputTokens, null);
  });

  it("classifies missing keys and invalid models as permanent", async () => {
    await assert.rejects(
      new OpenAiProviderAdapter(stubHttp(200, {}), undefined).execute(
        request("openai", "gpt-4o-mini")
      ),
      permanent("PROVIDER_API_KEY_MISSING")
    );
    await assert.rejects(
      new ClaudeProviderAdapter(stubHttp(200, {}), "key").execute(
        request("claude", "not-allowed")
      ),
      permanent("UNSUPPORTED_PROVIDER_MODEL")
    );
  });

  it("classifies 429 and 5xx as retryable and other 4xx as permanent", async () => {
    for (const [status, isPermanent] of [[429, false], [503, false], [400, true]] as const) {
      await assert.rejects(
        new GeminiProviderAdapter(stubHttp(status, {}), "key").execute(
          request("gemini", "gemini-1.5-flash")
        ),
        (error: unknown) =>
          error instanceof ProviderExecutionError &&
          error.permanent === isPermanent
      );
    }
  });
});

function request(provider: "openai" | "gemini" | "claude", model: string) {
  return {
    providerJobId: "1",
    provider,
    model,
    promptText: "Rendered canonical prompt",
    promptType: "visibility" as const,
    promptVersion: "v1",
    timeoutMs: 1000
  };
}

function stubHttp(status: number, body: unknown) {
  const requests: ProviderHttpRequest[] = [];
  return {
    requests,
    async postJson(input: ProviderHttpRequest) {
      requests.push(input);
      return { status, body };
    }
  } satisfies ProviderHttpClient & { requests: ProviderHttpRequest[] };
}

function permanent(code: string) {
  return (error: unknown) =>
    error instanceof ProviderExecutionError &&
    error.code === code &&
    error.permanent;
}
