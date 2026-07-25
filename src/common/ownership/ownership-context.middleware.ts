import type {
  Request,
  RequestHandler
} from "express";
import { ApplicationError } from "../errors/application-error.js";
import type { OwnershipContextService } from "./ownership-context.service.js";
import type { OwnershipContext } from "./ownership-context.types.js";

export function createOwnershipContextMiddleware(
  service: Pick<OwnershipContextService, "resolve">
): RequestHandler {
  return (request, _response, next) => {
    resolveRequestOwnership(request, service)
      .then((context) => {
        request.ownershipContext = Object.freeze(context);
        next();
      })
      .catch(next);
  };
}

export function requireOwnershipContext(request: Request): OwnershipContext {
  if (!request.ownershipContext) {
    throw new ApplicationError(
      "UNAUTHENTICATED",
      "Ownership context has not been resolved"
    );
  }
  return request.ownershipContext;
}

async function resolveRequestOwnership(
  request: Request,
  service: Pick<OwnershipContextService, "resolve">
) {
  const authorization = request.get("authorization");
  const workspaceId = optionalHeader(request, "x-workspace-id");
  const anonymousSessionToken = optionalHeader(
    request,
    "x-anonymous-session-token"
  );

  if (workspaceId && !/^[1-9]\d*$/.test(workspaceId)) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      "X-Workspace-Id must be a positive database identifier"
    );
  }

  return service.resolve({
    userSessionToken: parseBearerToken(authorization),
    anonymousSessionToken,
    workspaceId
  });
}

function parseBearerToken(authorization: string | undefined) {
  if (authorization === undefined) {
    return null;
  }

  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match?.[1]) {
    throw new ApplicationError(
      "UNAUTHENTICATED",
      "Authorization header must contain one Bearer token"
    );
  }
  return match[1];
}

function optionalHeader(request: Request, name: string) {
  const value = request.get(name);
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes(",")) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      `${name} must contain one value`
    );
  }
  return trimmed;
}
