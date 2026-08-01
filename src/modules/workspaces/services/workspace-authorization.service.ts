import { ApplicationError } from "../../../common/errors/application-error.js";
import type {
  WorkspaceMemberRow,
  WorkspaceRole
} from "../../../common/types/database.types.js";
import type { WorkspaceMemberRepository } from "../repositories/workspace-member.repository.js";

export const WORKSPACE_MUTATION_ROLES = ["owner", "admin", "member"] as const;

export function requireWorkspaceMutationRole(role: WorkspaceRole) {
  if (!(WORKSPACE_MUTATION_ROLES as readonly WorkspaceRole[]).includes(role)) {
    throw new ApplicationError(
      "FORBIDDEN",
      "Workspace role does not permit mutations"
    );
  }
  return role;
}

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

  requireMutationRole(membership: WorkspaceMemberRow) {
    requireWorkspaceMutationRole(membership.role);
    return membership;
  }
}
