export class ProviderExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly permanent = false,
    readonly invalidEvidence?: {
      rawResponse: unknown;
      validationErrors: string[];
    }
  ) {
    super(message);
    this.name = "ProviderExecutionError";
  }
}

export function providerHttpError(provider: string, status: number) {
  const retryable = status === 429 || status >= 500;
  return new ProviderExecutionError(
    status === 429
      ? "PROVIDER_RATE_LIMITED"
      : status >= 500
        ? "PROVIDER_UNAVAILABLE"
        : "PROVIDER_REQUEST_REJECTED",
    `${provider} request failed with HTTP ${status}`,
    !retryable
  );
}
