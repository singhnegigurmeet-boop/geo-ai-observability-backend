import { ApplicationError } from "../errors/application-error.js";
import type {
  WorkspaceMemberRow,
  WorkspaceRole
} from "../types/database.types.js";
import type { WorkspaceMemberRepository } from "./workspace-member.repository.js";

export class WorkspaceAuthorizationService {
  constructor(private readonly memberships: WorkspaceMemberRepository) {}

  async requireMembership(userId: string, workspaceId: string) {
    const membership = await this.memberships.findActiveMembership(
      userId,
      workspaceId
    );
    if (!membership) {
      throw new ApplicationError(
        "FORBIDDEN",
        "User is not a member of the requested workspace"
      );
    }
    return membership;
  }

  requireAnyRole(
    membership: WorkspaceMemberRow,
    allowedRoles: readonly WorkspaceRole[]
  ) {
    if (!allowedRoles.includes(membership.role)) {
      throw new ApplicationError(
        "FORBIDDEN",
        "Workspace role does not permit this action"
      );
    }
    return membership;
  }
}
