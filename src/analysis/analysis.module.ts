import type { Pool } from "pg";
import { AnonymousSessionRepository } from "../identity/anonymous-session.repository.js";
import { AnonymousSessionService } from "../identity/anonymous-session.service.js";
import { SessionTokenService } from "../identity/session-token.service.js";
import { UserRepository } from "../identity/user.repository.js";
import { UserSessionRepository } from "../identity/user-session.repository.js";
import { UserSessionService } from "../identity/user-session.service.js";
import { createOwnershipContextMiddleware } from "../ownership/ownership-context.middleware.js";
import { OwnershipContextService } from "../ownership/ownership-context.service.js";
import { WorkspaceAuthorizationService } from "../workspaces/workspace-authorization.service.js";
import { WorkspaceMemberRepository } from "../workspaces/workspace-member.repository.js";
import { AnalysisController } from "./analysis.controller.js";
import { createAnalysisRouter } from "./analysis.router.js";
import { AnalysisService } from "./analysis.service.js";

export type AnalysisModuleOptions = {
  sessionTokenPepper: string;
  userSessionTtlSeconds: number;
  anonymousSessionTtlSeconds: number;
  realProvidersEnabled?: boolean;
};

export function createAnalysisModule(
  database: Pool,
  options: AnalysisModuleOptions
) {
  const tokens = new SessionTokenService(options.sessionTokenPepper);
  const userSessions = new UserSessionService(
    new UserSessionRepository(database),
    new UserRepository(database),
    tokens,
    { ttlSeconds: options.userSessionTtlSeconds }
  );
  const anonymousSessions = new AnonymousSessionService(
    new AnonymousSessionRepository(database),
    database,
    tokens,
    { ttlSeconds: options.anonymousSessionTtlSeconds }
  );
  const ownership = new OwnershipContextService(
    userSessions,
    anonymousSessions,
    new WorkspaceAuthorizationService(
      new WorkspaceMemberRepository(database)
    )
  );
  const analyses = new AnalysisService(
    database,
    undefined,
    options.realProvidersEnabled ?? false
  );
  const controller = new AnalysisController(analyses);

  return createAnalysisRouter(
    controller,
    createOwnershipContextMiddleware(ownership)
  );
}
