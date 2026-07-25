import type {
  ProviderHttpClient,
  ProviderHttpRequest
} from "./provider-adapter.types.js";
import { ProviderExecutionError } from "./provider-execution.error.js";

export class FetchProviderHttpClient implements ProviderHttpClient {
  async postJson(request: ProviderHttpRequest) {
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(request.timeoutMs)
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ProviderExecutionError(
          "PROVIDER_TIMEOUT",
          "Provider request timed out"
        );
      }
      throw new ProviderExecutionError(
        "PROVIDER_NETWORK_ERROR",
        "Provider request failed before a response was received"
      );
    }
  }
}
