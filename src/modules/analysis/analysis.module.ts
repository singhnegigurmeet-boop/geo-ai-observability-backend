import type { Pool } from "pg";
import { AnonymousSessionRepository } from "../identity/repositories/anonymous-session.repository.js";
import { AnonymousSessionService } from "../identity/services/anonymous-session.service.js";
import { SessionTokenService } from "../identity/services/session-token.service.js";
import { UserRepository } from "../identity/repositories/user.repository.js";
import { UserSessionRepository } from "../identity/repositories/user-session.repository.js";
import { UserSessionService } from "../identity/services/user-session.service.js";
import { createOwnershipContextMiddleware } from "../../common/ownership/ownership-context.middleware.js";
import { OwnershipContextService } from "../../common/ownership/ownership-context.service.js";
import { WorkspaceAuthorizationService } from "../workspaces/services/workspace-authorization.service.js";
import { WorkspaceMemberRepository } from "../workspaces/repositories/workspace-member.repository.js";
import { AnalysisController } from "./controllers/analysis.controller.js";
import { createAnalysisRouter } from "./routes/analysis.router.js";
import { AnalysisService } from "./services/analysis.service.js";
import type { ProviderName } from "../../common/types/database.types.js";

export type AnalysisModuleOptions = {
  sessionTokenPepper: string;
  userSessionTtlSeconds: number;
  anonymousSessionTtlSeconds: number;
  realProvidersEnabled?: boolean;
  discoveryProvider?: ProviderName;
  discoveryModel?: string;
  discoveryFallbackProvider?: ProviderName;
  discoveryFallbackModel?: string;
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
    options.realProvidersEnabled ?? false,
    {
      provider: options.discoveryProvider ?? "mock",
      model: options.discoveryModel ?? "mock-fast",
      fallbackProvider: options.discoveryFallbackProvider ?? null,
      fallbackModel: options.discoveryFallbackModel ?? null,
      realProvidersEnabled: options.realProvidersEnabled ?? false
    }
  );
  const controller = new AnalysisController(analyses);

  return createAnalysisRouter(
    controller,
    createOwnershipContextMiddleware(ownership)
  );
}
