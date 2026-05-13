import { env } from "../config/env.js";

export async function postJson<TResponse>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  providerName: string
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`${providerName} API error ${response.status}: ${responseText}`);
    }

    return JSON.parse(responseText) as TResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${providerName} API request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function requireText(value: string | null | undefined, providerName: string) {
  if (!value || value.trim().length === 0) {
    throw new Error(`${providerName} API returned empty text`);
  }

  return value.trim();
}
