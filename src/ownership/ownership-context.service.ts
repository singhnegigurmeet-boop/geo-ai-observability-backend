import { ApplicationError } from "../errors/application-error.js";
import type { AnonymousSessionService } from "../identity/anonymous-session.service.js";
import type { UserSessionService } from "../identity/user-session.service.js";
import type { WorkspaceAuthorizationService } from "../workspaces/workspace-authorization.service.js";
import type {
  OwnershipContext,
  OwnershipCredentials
} from "./ownership-context.types.js";

export class OwnershipContextService {
  constructor(
    private readonly userSessions: Pick<UserSessionService, "resolve">,
    private readonly anonymousSessions: Pick<AnonymousSessionService, "resolve">,
    private readonly workspaceAuthorization: Pick<
      WorkspaceAuthorizationService,
      "requireMembership"
    >
  ) {}

  async resolve(
    credentials: OwnershipCredentials
  ): Promise<OwnershipContext> {
    if (credentials.workspaceId && !credentials.userSessionToken) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Workspace selection requires a user session"
      );
    }

    if (credentials.userSessionToken) {
      if (!credentials.workspaceId) {
        throw new ApplicationError(
          "VALIDATION_ERROR",
          "X-Workspace-Id is required for user sessions"
        );
      }

      const identity = await this.userSessions.resolve(
        credentials.userSessionToken
      );
      const membership =
        await this.workspaceAuthorization.requireMembership(
          identity.user.user_id,
          credentials.workspaceId
        );

      let anonymousSessionId: string | null = null;
      if (credentials.anonymousSessionToken) {
        const anonymous = await this.anonymousSessions.resolve(
          credentials.anonymousSessionToken
        );
        if (
          anonymous.claimed_by_user_id !== identity.user.user_id ||
          anonymous.claimed_workspace_id !== credentials.workspaceId
        ) {
          throw new ApplicationError(
            "FORBIDDEN",
            "Anonymous session claim does not match the authenticated owner"
          );
        }
        anonymousSessionId = anonymous.anonymous_session_id;
      }

      return {
        actorType: "user",
        anonymousSessionId,
        userId: identity.user.user_id,
        workspaceId: credentials.workspaceId,
        workspaceRole: membership.role
      };
    }

    if (credentials.anonymousSessionToken) {
      const anonymous = await this.anonymousSessions.resolve(
        credentials.anonymousSessionToken
      );
      return {
        actorType: "anonymous",
        anonymousSessionId: anonymous.anonymous_session_id,
        userId: null,
        workspaceId: null
      };
    }

    throw new ApplicationError(
      "UNAUTHENTICATED",
      "A user or anonymous session is required"
    );
  }
}
