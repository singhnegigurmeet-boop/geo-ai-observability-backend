export const APPLICATION_ERROR_CATEGORIES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION_ERROR",
  "EXPIRED_SESSION",
  "REVOKED_SESSION",
  "DISABLED_USER"
] as const;

export type ApplicationErrorCategory =
  (typeof APPLICATION_ERROR_CATEGORIES)[number];

const statusByCategory: Record<ApplicationErrorCategory, number> = {
  UNAUTHENTICATED: 401,
  EXPIRED_SESSION: 401,
  REVOKED_SESSION: 401,
  FORBIDDEN: 403,
  DISABLED_USER: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 400
};

export class ApplicationError extends Error {
  readonly statusCode: number;

  constructor(
    readonly category: ApplicationErrorCategory,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ApplicationError";
    this.statusCode = statusByCategory[category];
  }
}

export function isPostgresErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code: unknown }).code) === code
  );
}
