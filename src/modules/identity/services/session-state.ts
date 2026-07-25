import { ApplicationError } from "../../../common/errors/application-error.js";
import type { SessionStatus } from "../../../common/types/database.types.js";

export function assertSessionUsable(
  status: SessionStatus,
  expiresAt: Date,
  now: Date
) {
  if (status === "revoked") {
    throw new ApplicationError("REVOKED_SESSION", "Session has been revoked");
  }
  if (status === "expired" || expiresAt.getTime() <= now.getTime()) {
    throw new ApplicationError("EXPIRED_SESSION", "Session has expired");
  }
  if (status !== "active") {
    throw new ApplicationError("UNAUTHENTICATED", "Session is not active");
  }
}
