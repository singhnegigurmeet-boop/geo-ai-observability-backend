/**
 * BaseService - Common functionality for all services
 */
export class BaseService {
  /**
   * Parse JSON with error handling
   */
  protected parseJson<T>(rawJson: string, errorMessage = "Invalid JSON response"): T {
    try {
      return JSON.parse(rawJson) as T;
    } catch {
      throw new Error(errorMessage);
    }
  }

  /**
   * Retry an async operation a fixed number of times.
   */
  protected async withRetries<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Operation failed");
  }

  /**
   * Round number to specified decimal places
   */
  protected roundNumber(value: number, decimals: number = 2): number {
    return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
  }

  /**
   * Calculate average of numbers
   */
  protected average(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  /**
   * Log with service name prefix
   */
  protected log(message: string, data?: unknown): void {
    const serviceName = this.constructor.name;
    if (data) {
      console.log(`[${serviceName}] ${message}`, data);
    } else {
      console.log(`[${serviceName}] ${message}`);
    }
  }

  /**
   * Log error with service name prefix
   */
  protected logError(message: string, error?: unknown): void {
    const serviceName = this.constructor.name;
    console.error(`[${serviceName}] ${message}`, error);
  }
}
