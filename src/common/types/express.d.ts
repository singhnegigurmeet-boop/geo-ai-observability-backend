import type { OwnershipContext } from "../ownership/ownership-context.types.js";

declare global {
  namespace Express {
    interface Request {
      ownershipContext?: OwnershipContext;
    }
  }
}

export {};
