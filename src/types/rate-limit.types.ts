export type RateLimitResult =
  | {
      allowed: true;
      current: number;
      limit: number;
    }
  | {
      allowed: false;
      current: number;
      limit: number;
      retryAfterSeconds: number;
      reason: string;
    };
