import {
  createHmac,
  randomBytes
} from "node:crypto";
import { ApplicationError } from "../errors/application-error.js";

const SESSION_TOKEN_BYTES = 32;

export class SessionTokenService {
  constructor(private readonly pepper: string) {
    if (pepper.length < 32) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Session token pepper must be at least 32 characters"
      );
    }
  }

  generate() {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    return {
      token,
      tokenHash: this.hash(token)
    };
  }

  hash(token: string) {
    if (!token) {
      throw new ApplicationError(
        "UNAUTHENTICATED",
        "Session token is required"
      );
    }
    return createHmac("sha256", this.pepper)
      .update(token, "utf8")
      .digest("hex");
  }
}
