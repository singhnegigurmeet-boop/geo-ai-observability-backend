import type { WorkspaceRole } from "../types/database.types.js";

export type OwnershipContext =
  | {
      actorType: "anonymous";
      anonymousSessionId: string;
      userId: null;
      workspaceId: null;
    }
  | {
      actorType: "user";
      anonymousSessionId: string | null;
      userId: string;
      workspaceId: string;
      workspaceRole: WorkspaceRole;
    };

export type OwnershipCredentials = {
  userSessionToken: string | null;
  anonymousSessionToken: string | null;
  workspaceId: string | null;
};
