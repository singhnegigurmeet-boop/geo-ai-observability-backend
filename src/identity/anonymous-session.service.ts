import type { TransactionPool } from "../db/database-executor.js";
import { inTransaction } from "../db/database-executor.js";
import { ApplicationError } from "../errors/application-error.js";
import type { AnonymousSessionRow } from "../types/database.types.js";
import { WorkspaceMemberRepository } from "../workspaces/workspace-member.repository.js";
import { AnonymousSessionRepository } from "./anonymous-session.repository.js";
import type {
  CreateAnonymousSessionInput,
  CreatedSession
} from "./identity.types.js";
import { assertSessionUsable } from "./session-state.js";
import type { SessionTokenService } from "./session-token.service.js";

export type AnonymousSessionServiceOptions = {
  ttlSeconds: number;
  now?: () => Date;
};

export type ClaimAnonymousSessionInput = {
  anonymousSessionId: string;
  userId: string;
  workspaceId: string;
};

export class AnonymousSessionService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: AnonymousSessionRepository,
    private readonly transactionPool: TransactionPool,
    private readonly tokens: SessionTokenService,
    private readonly options: AnonymousSessionServiceOptions
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async create(
    input: CreateAnonymousSessionInput = {}
  ): Promise<CreatedSession<AnonymousSessionRow>> {
    const generated = this.tokens.generate();
    const createdAt = this.now();
    const session = await this.repository.create({
      tokenHash: generated.tokenHash,
      expiresAt: new Date(
        createdAt.getTime() + this.options.ttlSeconds * 1_000
      ),
      clientMetadata: input.clientMetadata ?? {}
    });
    return { session, token: generated.token };
  }

  async resolve(token: string) {
    const tokenHash = this.tokens.hash(token);
    const session = await this.repository.findByTokenHash(tokenHash);
    if (!session) {
      throw new ApplicationError(
        "UNAUTHENTICATED",
        "Anonymous session was not found"
      );
    }

    const now = this.now();
    assertSessionUsable(session.status, session.expires_at, now);
    await this.repository.touchLastSeen(session.anonymous_session_id, now);
    return session;
  }

  async claim(input: ClaimAnonymousSessionInput) {
    return inTransaction(this.transactionPool, async (client) => {
      const anonymousSessions = new AnonymousSessionRepository(client);
      const memberships = new WorkspaceMemberRepository(client);
      const session = await anonymousSessions.findByIdForUpdate(
        input.anonymousSessionId
      );
      if (!session) {
        throw new ApplicationError(
          "NOT_FOUND",
          "Anonymous session was not found"
        );
      }

      const now = this.now();
      assertSessionUsable(session.status, session.expires_at, now);

      if (
        session.claimed_by_user_id !== null &&
        (session.claimed_by_user_id !== input.userId ||
          session.claimed_workspace_id !== input.workspaceId)
      ) {
        throw new ApplicationError(
          "CONFLICT",
          "Anonymous session is already claimed by another owner"
        );
      }

      const membership = await memberships.findActiveMembership(
        input.userId,
        input.workspaceId
      );
      if (!membership) {
        throw new ApplicationError(
          "FORBIDDEN",
          "User is not a member of the requested workspace"
        );
      }

      if (
        session.claimed_by_user_id === input.userId &&
        session.claimed_workspace_id === input.workspaceId
      ) {
        return session;
      }

      const claimed = await anonymousSessions.claim(
        input.anonymousSessionId,
        input.userId,
        input.workspaceId,
        now
      );
      if (!claimed) {
        throw new ApplicationError(
          "CONFLICT",
          "Anonymous session claim changed concurrently"
        );
      }
      return claimed;
    });
  }
}
