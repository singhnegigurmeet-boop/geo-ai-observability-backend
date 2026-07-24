import { ApplicationError } from "../errors/application-error.js";
import type { JsonObject } from "../types/database.types.js";
import type { CreatedSession, UserSessionIdentity } from "./identity.types.js";
import { assertSessionUsable } from "./session-state.js";
import type { SessionTokenService } from "./session-token.service.js";
import type { UserRepository } from "./user.repository.js";
import type { UserSessionRepository } from "./user-session.repository.js";

export type UserSessionServiceOptions = {
  ttlSeconds: number;
  now?: () => Date;
};

export class UserSessionService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: UserSessionRepository,
    private readonly users: UserRepository,
    private readonly tokens: SessionTokenService,
    private readonly options: UserSessionServiceOptions
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(
    userId: string,
    clientMetadata: JsonObject = {}
  ): Promise<CreatedSession<UserSessionIdentity["session"]>> {
    const user = await this.users.findActiveById(userId);
    if (!user) {
      throw new ApplicationError(
        "DISABLED_USER",
        "Active user is required to create a session"
      );
    }

    const generated = this.tokens.generate();
    const createdAt = this.now();
    const session = await this.repository.create({
      userId,
      tokenHash: generated.tokenHash,
      expiresAt: new Date(
        createdAt.getTime() + this.options.ttlSeconds * 1_000
      ),
      clientMetadata
    });
    return { session, token: generated.token };
  }

  async resolve(token: string) {
    const tokenHash = this.tokens.hash(token);
    const identity = await this.repository.findIdentityByTokenHash(tokenHash);
    if (!identity) {
      throw new ApplicationError(
        "UNAUTHENTICATED",
        "User session was not found"
      );
    }

    const now = this.now();
    assertSessionUsable(identity.session.status, identity.session.expires_at, now);
    if (
      identity.user.status !== "active" ||
      identity.user.deleted_at !== null
    ) {
      throw new ApplicationError("DISABLED_USER", "User is not active");
    }

    await this.repository.touchLastSeen(
      identity.session.user_session_id,
      now
    );
    return identity;
  }
}
