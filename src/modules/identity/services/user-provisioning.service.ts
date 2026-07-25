import type { TransactionPool } from "../../../common/database/database-executor.js";
import { inTransaction } from "../../../common/database/database-executor.js";
import {
  ApplicationError,
  isPostgresErrorCode
} from "../../../common/errors/application-error.js";
import { WorkspaceMemberRepository } from "../../workspaces/repositories/workspace-member.repository.js";
import { WorkspaceRepository } from "../../workspaces/repositories/workspace.repository.js";
import { UserRepository } from "../repositories/user.repository.js";

export type ProvisionUserInput = {
  email: string;
  displayName?: string | null;
  passwordHash?: string | null;
  defaultWorkspaceName: string;
};

export class UserProvisioningService {
  constructor(private readonly transactionPool: TransactionPool) {}

  async createUserWithDefaultWorkspace(input: ProvisionUserInput) {
    const normalized = validateAndNormalizeProvisioningInput(input);

    try {
      return await inTransaction(this.transactionPool, async (client) => {
        const users = new UserRepository(client);
        const workspaces = new WorkspaceRepository(client);
        const members = new WorkspaceMemberRepository(client);

        const user = await users.create({
          email: normalized.email,
          displayName: normalized.displayName,
          passwordHash: normalized.passwordHash
        });
        const workspace = await workspaces.create(
          normalized.defaultWorkspaceName,
          user.user_id
        );
        const membership = await members.add(
          user.user_id,
          workspace.workspace_id,
          "owner"
        );

        return { user, workspace, membership };
      });
    } catch (error) {
      if (isPostgresErrorCode(error, "23505")) {
        throw new ApplicationError(
          "CONFLICT",
          "A user with this email already exists",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function validateAndNormalizeProvisioningInput(input: ProvisionUserInput) {
  const email = input.email.trim().toLowerCase();
  const workspaceName = input.defaultWorkspaceName.trim();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    workspaceName.length === 0
  ) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      "A valid email and default workspace name are required"
    );
  }

  return {
    email,
    defaultWorkspaceName: workspaceName,
    displayName: input.displayName?.trim() || null,
    passwordHash: input.passwordHash ?? null
  };
}
